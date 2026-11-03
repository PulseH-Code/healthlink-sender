import fsp from "node:fs/promises";
import path from "node:path";
import { isKnownAckCode, parseAck } from "./hl7.js";

const SETTLE_MS = 2_000;
const OUR_FOLDERS = new Set(["processed", "other"]);

/** YYYY-MM-DD in local time, for the processed/ date folders. */
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

/**
 * Polls HL7_in. For every new file:
 *   * an ACK (MSA segment) whose MSA-2 matches a message we sent →
 *     record MSA-1 / text, queue the report to VascIQ, move to
 *     processed/<date>/
 *   * anything else (test messages, broadcasts, ACKs for unknown ids) →
 *     log it and move to other/. Nothing is ever deleted.
 */
export function createWatcher({ db, config, log, webhook }) {
  async function processFile(file) {
    const text = await fsp.readFile(file, "utf8");
    const parsed = parseAck(text);
    const name = path.basename(file);

    if (!parsed.isAck) {
      const moved = await moveTo(file, path.join(config.hl7In, "other"));
      log.info("non-ACK file filed", { file: name, messageType: parsed.messageType || "?", movedTo: moved });
      return { kind: "other" };
    }

    const message = parsed.controlId ? db.getMessage(parsed.controlId) : null;
    if (!message) {
      const moved = await moveTo(file, path.join(config.hl7In, "other"));
      log.warn("ACK for unknown control id filed", { file: name, controlId: parsed.controlId, movedTo: moved });
      return { kind: "unknown" };
    }

    const ackCode = isKnownAckCode(parsed.ackCode) ? parsed.ackCode : "AE";
    const ackText = isKnownAckCode(parsed.ackCode)
      ? parsed.text
      : [`Unrecognised MSA-1 "${parsed.ackCode}"`, parsed.text].filter(Boolean).join(" | ");

    db.recordAck(parsed.controlId, { ackCode, ackText, file: name });
    webhook.enqueue(parsed.controlId, ackCode, ackText);
    const moved = await moveTo(file, path.join(config.hl7In, "processed", today()));
    log.info("ACK matched", { controlId: parsed.controlId, ackCode, ackText, movedTo: moved });
    return { kind: "ack", controlId: parsed.controlId, ackCode };
  }

  async function processOnce() {
    const summary = { files: 0, acks: 0, other: 0, errors: 0 };
    let entries;
    try {
      entries = await fsp.readdir(config.hl7In, { withFileTypes: true });
    } catch (err) {
      log.error("cannot read HL7_in", { path: config.hl7In, error: String(err?.message ?? err) });
      summary.errors++;
      return summary;
    }

    const now = Date.now();
    for (const entry of entries) {
      if (entry.isDirectory()) continue; // our processed/ and other/, or HMS subfolders
      if (OUR_FOLDERS.has(entry.name)) continue;
      const file = path.join(config.hl7In, entry.name);
      try {
        const stat = await fsp.stat(file);
        if (now - stat.mtimeMs < SETTLE_MS) continue; // still being written
        summary.files++;
        const result = await processFile(file);
        if (result.kind === "ack") summary.acks++;
        else summary.other++;
      } catch (err) {
        summary.errors++;
        log.error("failed to process inbound file", { file: entry.name, error: String(err?.message ?? err) });
      }
    }

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
      log.info("watcher started", { hl7In: config.hl7In, everyMs: config.watchIntervalMs });
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
