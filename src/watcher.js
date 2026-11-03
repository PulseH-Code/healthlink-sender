import fsp from "node:fs/promises";
import path from "node:path";
import { isKnownAckCode, parseAck } from "./hl7.js";
import { validControlId } from "./outbox.js";

const SETTLE_MS = 2_000;

/** YYYY-MM-DD in local time, for the archive date folders. */
function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function moveTo(file, dir) {
  await fsp.mkdir(dir, { recursive: true });
  let target = path.join(dir, path.basename(file));
  try {
    await fsp.access(target);
    const ext = path.extname(target);
    target = path.join(dir, `${path.basename(target, ext)}.${Date.now()}${ext}`);
  } catch {
    // no collision
  }
  await fsp.rename(file, target);
  return target;
}

/** Top-level files in `dir` that have not been modified in the last 2 s. */
async function settledFiles(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return { files: [], missing: true };
    throw err;
  }
  const now = Date.now();
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // the client's rejected/ and any other subfolders
    const file = path.join(dir, entry.name);
    const stat = await fsp.stat(file);
    if (now - stat.mtimeMs < SETTLE_MS) continue; // still being written
    files.push(file);
  }
  return { files, missing: false };
}

/**
 * Polls the HMS client's folders for one message type.
 *
 *   HL7_in\<TYPE>            an ACK (MSA segment) whose MSA-2 matches a message
 *                            we sent → record MSA-1 / text, queue the report
 *                            to VascIQ, archive under processed/<date>/.
 *                            Anything else → archive under other/.
 *   HL7_out\<TYPE>\rejected  a file the client refused to send → reported to
 *                            VascIQ as AR, archived under rejected/<date>/.
 *   HL7_in\<TYPE>\rejected   inbound the client could not read → logged,
 *                            archived under other/.
 * Nothing is ever deleted. The archive lives outside the client's tree.
 */
export function createWatcher({ db, config, log, webhook }) {
  const archive = (sub) => path.join(config.archive, sub);

  async function processInbound(file) {
    const text = await fsp.readFile(file, "utf8");
    const parsed = parseAck(text);
    const name = path.basename(file);

    if (!parsed.isAck) {
      const moved = await moveTo(file, archive("other"));
      log.info("non-ACK file filed", { file: name, messageType: parsed.messageType || "?", movedTo: moved });
      return { kind: "other" };
    }

    const message = parsed.controlId ? db.getMessage(parsed.controlId) : null;
    if (!message) {
      const moved = await moveTo(file, archive("other"));
      log.warn("ACK for unknown control id filed", { file: name, controlId: parsed.controlId, movedTo: moved });
      return { kind: "unknown" };
    }

    const ackCode = isKnownAckCode(parsed.ackCode) ? parsed.ackCode : "AE";
    const ackText = isKnownAckCode(parsed.ackCode)
      ? parsed.text
      : [`Unrecognised MSA-1 "${parsed.ackCode}"`, parsed.text].filter(Boolean).join(" | ");

    db.recordAck(parsed.controlId, { ackCode, ackText, file: name });
    webhook.enqueue(parsed.controlId, ackCode, ackText);
    const moved = await moveTo(file, archive(path.join("processed", today())));
    log.info("ACK matched", { controlId: parsed.controlId, ackCode, ackText, movedTo: moved });
    return { kind: "ack", controlId: parsed.controlId, ackCode };
  }

  /** A file the HMS client moved to processErrorDir: it will never be sent. */
  async function processOutboundRejected(file) {
    const name = path.basename(file);
    const controlId = path.basename(name, path.extname(name));
    const message = validControlId(controlId) ? db.getMessage(controlId) : null;
    const moved = await moveTo(file, archive(path.join("rejected", today())));
    if (!message) {
      log.warn("unknown file in HL7_out rejected folder filed", { file: name, movedTo: moved });
      return { kind: "other" };
    }
    if (message.ack_code) {
      log.warn("rejected file for an already-acknowledged message filed", { controlId, movedTo: moved });
      return { kind: "other" };
    }
    const ackText = "Rejected by the HealthLink client before sending — see the HMS LOG folder";
    db.recordAck(controlId, { ackCode: "AR", ackText, file: name });
    webhook.enqueue(controlId, "AR", ackText);
    log.error("message rejected by HMS client", { controlId, movedTo: moved });
    return { kind: "rejected", controlId };
  }

  async function processInboundRejected(file) {
    const moved = await moveTo(file, archive("other"));
    log.warn("inbound file the HMS client could not read filed", { file: path.basename(file), movedTo: moved });
    return { kind: "other" };
  }

  async function scan(dir, handler, summary, { required }) {
    let listing;
    try {
      listing = await settledFiles(dir);
    } catch (err) {
      log.error("cannot read folder", { path: dir, error: String(err?.message ?? err) });
      summary.errors++;
      return;
    }
    if (listing.missing) {
      if (required) {
        log.error("folder does not exist", { path: dir });
        summary.errors++;
      }
      return;
    }
    for (const file of listing.files) {
      summary.files++;
      try {
        const result = await handler(file);
        if (result.kind === "ack") summary.acks++;
        else if (result.kind === "rejected") summary.rejected++;
        else summary.other++;
      } catch (err) {
        summary.errors++;
        log.error("failed to process file", { file: path.basename(file), error: String(err?.message ?? err) });
      }
    }
  }

  async function processOnce() {
    const summary = { files: 0, acks: 0, rejected: 0, other: 0, errors: 0 };
    await scan(config.hl7In, processInbound, summary, { required: true });
    await scan(config.hl7OutRejected, processOutboundRejected, summary, { required: false });
    await scan(config.hl7InRejected, processInboundRejected, summary, { required: false });

    // Push any newly queued (or previously failed) reports.
    try {
      await webhook.drain();
    } catch (err) {
      log.error("webhook drain failed", { error: String(err?.message ?? err) });
    }
    return summary;
  }

  let timer = null;
  let running = false;
  return {
    processOnce,
    start() {
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          await processOnce();
        } finally {
          running = false;
        }
      };
      timer = setInterval(tick, config.watchIntervalMs);
      void tick();
      log.info("watcher started", {
        hl7In: config.hl7In,
        hl7OutRejected: config.hl7OutRejected,
        archive: config.archive,
        everyMs: config.watchIntervalMs,
      });
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
