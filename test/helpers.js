import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { silentLogger } from "../src/log.js";
import { createWebhookClient } from "../src/webhook.js";
import { createWatcher } from "../src/watcher.js";
import { createAlerts } from "../src/alerts.js";
import { createServer } from "../src/http.js";

/** Fake HMS folders in a temp dir, an in-memory DB, and a fake VascIQ webhook. */
export async function makeHarness(overrides = {}) {
  // Mirrors the real HMS layout: <HLINK>\HL7_out\<TYPE>\rejected etc.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hl-sender-"));
  const hl7Out = path.join(root, "HL7_out", "RSDNZ");
  const hl7In = path.join(root, "HL7_in", "RSDNZ");
  fs.mkdirSync(path.join(hl7Out, "rejected"), { recursive: true });
  fs.mkdirSync(path.join(hl7In, "rejected"), { recursive: true });

  // Fake VascIQ: records every webhook call, answers with a scripted status.
  const webhookCalls = [];
  let webhookStatus = 200;
  const fakeVascIQ = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      webhookCalls.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(webhookStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: webhookStatus < 300 }));
    });
  });
  await new Promise((r) => fakeVascIQ.listen(0, "127.0.0.1", r));

  const config = {
    hl7Out,
    hl7In,
    hl7OutRejected: path.join(hl7Out, "rejected"),
    hl7InRejected: path.join(hl7In, "rejected"),
    staging: path.join(root, "vasciq-staging"),
    archive: path.join(root, "vasciq-archive"),
    apiKey: "test-api-key",
    webhookUrl: `http://127.0.0.1:${fakeVascIQ.address().port}/api/delivery/ack`,
    webhookSecret: "test-webhook-secret",
    port: 0,
    host: "127.0.0.1",
    tls: null,
    alertEmail: "ops@example.test",
    smtp: null,
    watchIntervalMs: 50,
    stuckFileMinutes: 30,
    webhookFailingMinutes: 15,
    ...overrides,
  };

  const db = openDb(":memory:");
  const log = silentLogger;
  const webhook = createWebhookClient({ db, config, log });
  const watcher = createWatcher({ db, config, log, webhook });
  const sentMail = [];
  const mailer = { async send(m) { sentMail.push(m); } };
  const alerts = createAlerts({ db, config, log, mailer });
  const api = createServer({ db, config, log, alerts });
  const addr = await api.listen();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    root,
    hl7Out,
    hl7In,
    archive: config.archive,
    config,
    db,
    webhook,
    watcher,
    alerts,
    sentMail,
    baseUrl,
    webhookCalls,
    setWebhookStatus: (s) => (webhookStatus = s),
    async send(body, apiKey = config.apiKey) {
      const res = await fetch(`${baseUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    async get(pathname, apiKey = config.apiKey) {
      const res = await fetch(`${baseUrl}${pathname}`, { headers: apiKey ? { "x-api-key": apiKey } : {} });
      return { status: res.status, body: await res.json() };
    },
    /** Write a file into HL7_in with an old mtime so the watcher treats it as settled. */
    dropInbound(name, text, dir = hl7In) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text);
      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(file, old, old);
      return file;
    },
    /** Simulate the HMS client refusing an outbound file: move it to HL7_out\<TYPE>\rejected. */
    rejectOutbound(filename) {
      const target = path.join(hl7Out, "rejected", filename);
      fs.renameSync(path.join(hl7Out, filename), target);
      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(target, old, old);
      return target;
    },
    async close() {
      watcher.stop();
      alerts.stop();
      await api.close();
      await new Promise((r) => fakeVascIQ.close(r));
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export const SAMPLE_ORU =
  "MSH|^~\\&|PULSEIQ|pulseus|HEALTHLINK|ccoastst|20261029150743|PKI|ORU|000001|P|2.1\r" +
  "MSA|AA|000001\r" +
  "PID|1||ZZZ0016||TEST^PULSE||19700101|F|||100 TESTING STREET^TE ARO^WELLINGTON 6011\r" +
  "OBR|1|EVENT123456|PU2026001234^PULSE|USVLV^US Lower Limb Venous Duplex Bilateral^L\r" +
  "OBX|1|FT|USVLV^US Lower Limb Venous Duplex Bilateral^L|1|Report \\F\\ text\\.br\\line two||||||F\r";

export function ackFor(controlId, code = "AA", text = "") {
  return (
    `MSH|^~\\&|HEALTHLINK|ccoastst|PULSEIQ|pulseus|20261102101500||ACK|998877|P|2.1\r` +
    `MSA|${code}|${controlId}${text ? `|${text}` : ""}\r`
  );
}
