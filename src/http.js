import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";
import { validControlId, writeMessage } from "./outbox.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 *   POST /send              (x-api-key)  { controlId, destination, message, testMode } → 202
 *   GET  /status/:controlId (x-api-key)  what we know about a message
 *   GET  /health                         ok + folder reachability and file ages
 */
export function createServer({ db, config, log, alerts }) {
  const authed = (req) => constantTimeEqual(req.headers["x-api-key"], config.apiKey);

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const started = Date.now();
    const done = (status, body) => {
      json(res, status, body);
      if (url.pathname !== "/health") {
        log.info(`${req.method} ${url.pathname} ${status}`, { ms: Date.now() - started });
      }
    };

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        const folders = await alerts.folderStatus();
        const ok = folders.hl7Out.reachable && folders.hl7In.reachable;
        return done(ok ? 200 : 503, {
          ok,
          folders,
          messages: db.countMessages(),
          pendingWebhooks: db.oldestPendingWebhook() ? true : false,
          uptimeSeconds: Math.round(process.uptime()),
        });
      }

      if (!authed(req)) return done(401, { ok: false, error: "Unauthorised." });

      if (req.method === "POST" && url.pathname === "/send") {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          return done(err?.status ?? 400, { ok: false, error: err?.status ? err.message : "Invalid JSON." });
        }
        const { controlId, destination, message, testMode } = body ?? {};
        if (!validControlId(controlId)) return done(400, { ok: false, error: "controlId must be 1–20 letters, digits, - or _." });
        if (typeof destination !== "string" || !destination.trim()) return done(400, { ok: false, error: "destination is required." });
        if (typeof message !== "string" || !message.startsWith("MSH|")) return done(400, { ok: false, error: "message must be an HL7 message starting with MSH|." });

        db.recordReceived({ controlId, destination, testMode: Boolean(testMode), bytes: Buffer.byteLength(message) });
        const { filename, duplicate } = await writeMessage(config, controlId, message);
        if (!duplicate) db.recordWritten(controlId, filename);
        log.info(duplicate ? "message already in HL7_out (duplicate accepted)" : "message written to HL7_out", {
          controlId,
          destination,
          testMode: Boolean(testMode),
          filename,
        });
        return done(202, { ok: true, controlId, filename, duplicate });
      }

      const status = url.pathname.match(/^\/status\/([^/]+)$/);
      if (req.method === "GET" && status) {
        const controlId = decodeURIComponent(status[1]);
        const message = db.getMessage(controlId);
        if (!message) return done(404, { ok: false, error: "Unknown control id." });
        const report = db.webhookFor(controlId);
        return done(200, {
          ok: true,
          controlId,
          destination: message.destination,
          testMode: Boolean(message.test_mode),
          receivedAt: message.received_at,
          writtenAt: message.written_at,
          filename: message.filename,
          acked: Boolean(message.ack_code),
          ackCode: message.ack_code,
          ackText: message.ack_text,
          ackAt: message.ack_at,
          reportedToVascIQ: report?.delivered_at ?? null,
          reportAttempts: report?.attempts ?? 0,
          reportLastError: report?.last_error ?? null,
        });
      }

      return done(404, { ok: false, error: "Not found." });
    } catch (err) {
      log.error("request failed", { method: req.method, path: url.pathname, error: String(err?.message ?? err) });
      return done(500, { ok: false, error: "Internal error." });
    }
  }

  const server = config.tls
    ? https.createServer(
        { cert: fs.readFileSync(config.tls.certPath), key: fs.readFileSync(config.tls.keyPath) },
        handle
      )
    : http.createServer(handle);

  return {
    server,
    listen: () =>
      new Promise((resolve) => {
        server.listen(config.port, config.host, () => {
          const addr = server.address();
          log.info(`listening on ${config.tls ? "https" : "http"}://${config.host}:${addr.port}`);
          resolve(addr);
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
