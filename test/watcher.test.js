import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ackFor, makeHarness, SAMPLE_ORU } from "./helpers.js";

test("matches an AA ACK and an AE ACK to their control ids and calls the webhook", async () => {
  const h = await makeHarness();
  try {
    await h.send({ controlId: "000010", destination: "ccdhb", message: SAMPLE_ORU, testMode: true });
    await h.send({ controlId: "000011", destination: "ccdhb", message: SAMPLE_ORU, testMode: true });
    h.dropInbound("ack-a.hl7", ackFor("000010", "AA"));
    h.dropInbound("ack-b.hl7", ackFor("000011", "AE", "PID-3 unknown NHI"));

    const summary = await h.watcher.processOnce();
    assert.equal(summary.acks, 2);
    assert.equal(summary.errors, 0);

    // Webhook called once per ACK with the shared secret.
    assert.equal(h.webhookCalls.length, 2);
    const byId = Object.fromEntries(h.webhookCalls.map((c) => [c.body.controlId, c]));
    assert.deepEqual(byId["000010"].body, { controlId: "000010", ackCode: "AA", ackText: null });
    assert.deepEqual(byId["000011"].body, { controlId: "000011", ackCode: "AE", ackText: "PID-3 unknown NHI" });
    assert.equal(byId["000010"].headers["x-webhook-secret"], "test-webhook-secret");

    // Recorded locally and visible on /status.
    const status = await h.get("/status/000011");
    assert.equal(status.body.ackCode, "AE");
    assert.equal(status.body.ackText, "PID-3 unknown NHI");
    assert.ok(status.body.reportedToVascIQ);

    // Files archived under processed/<date>/ outside the client's tree,
    // nothing deleted, HL7_in\<TYPE> left with only the client's rejected/.
    const processed = path.join(h.archive, "processed");
    const dateDirs = fs.readdirSync(processed);
    assert.equal(dateDirs.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(processed, dateDirs[0])).sort(), ["ack-a.hl7", "ack-b.hl7"]);
    assert.deepEqual(fs.readdirSync(h.hl7In), ["rejected"]);
  } finally {
    await h.close();
  }
});

test("ignores and files away non-ACK messages and ACKs for unknown ids", async () => {
  const h = await makeHarness();
  try {
    h.dropInbound("broadcast.hl7", "MSH|^~\\&|HEALTHLINK|hlink|PULSEIQ|pulseus|20261102101500||ADT^A08|1|P|2.1\rPID|1||ABC1234\r");
    h.dropInbound("stray-ack.hl7", ackFor("999999", "AA"));
    h.dropInbound("notes.txt", "hello there");

    const summary = await h.watcher.processOnce();
    assert.equal(summary.files, 3);
    assert.equal(summary.acks, 0);
    assert.equal(summary.other, 3);
    assert.equal(h.webhookCalls.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(h.archive, "other")).sort(), ["broadcast.hl7", "notes.txt", "stray-ack.hl7"]);
  } finally {
    await h.close();
  }
});

test("reports a message the HMS client refused to send as AR", async () => {
  const h = await makeHarness();
  try {
    await h.send({ controlId: "000015", destination: "ccdhb", message: SAMPLE_ORU, testMode: true });
    h.rejectOutbound("000015.hl7");
    h.dropInbound("garbled.hl7", "not hl7 at all", path.join(h.hl7In, "rejected"));

    const summary = await h.watcher.processOnce();
    assert.equal(summary.rejected, 1);
    assert.equal(summary.other, 1);

    assert.equal(h.webhookCalls.length, 1);
    assert.equal(h.webhookCalls[0].body.controlId, "000015");
    assert.equal(h.webhookCalls[0].body.ackCode, "AR");
    assert.match(h.webhookCalls[0].body.ackText, /HealthLink client/);

    const status = await h.get("/status/000015");
    assert.equal(status.body.ackCode, "AR");

    // Both archived; the client's rejected folders are empty again.
    assert.deepEqual(fs.readdirSync(path.join(h.hl7Out, "rejected")), []);
    assert.deepEqual(fs.readdirSync(path.join(h.hl7In, "rejected")), []);
    const rejected = path.join(h.archive, "rejected");
    assert.deepEqual(fs.readdirSync(path.join(rejected, fs.readdirSync(rejected)[0])), ["000015.hl7"]);
    assert.deepEqual(fs.readdirSync(path.join(h.archive, "other")), ["garbled.hl7"]);
  } finally {
    await h.close();
  }
});

test("skips files still being written and leaves subfolders alone", async () => {
  const h = await makeHarness();
  try {
    await h.send({ controlId: "000020", destination: "ccdhb", message: SAMPLE_ORU, testMode: true });
    fs.writeFileSync(path.join(h.hl7In, "fresh.hl7"), ackFor("000020")); // mtime = now
    fs.mkdirSync(path.join(h.hl7In, "archive")); // some folder of the client's we must not touch

    const first = await h.watcher.processOnce();
    assert.equal(first.files, 0, "fresh file not touched yet");
    assert.ok(fs.existsSync(path.join(h.hl7In, "fresh.hl7")));

    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(path.join(h.hl7In, "fresh.hl7"), old, old);
    const second = await h.watcher.processOnce();
    assert.equal(second.acks, 1);
    assert.ok(fs.existsSync(path.join(h.hl7In, "archive")));
  } finally {
    await h.close();
  }
});

test("retries the webhook with backoff until VascIQ answers 2xx", async () => {
  const h = await makeHarness();
  try {
    await h.send({ controlId: "000030", destination: "ccdhb", message: SAMPLE_ORU, testMode: true });
    h.dropInbound("ack.hl7", ackFor("000030"));
    h.setWebhookStatus(500);

    await h.watcher.processOnce();
    assert.equal(h.webhookCalls.length, 1);
    const pending = h.db.oldestPendingWebhook();
    assert.equal(pending.attempts, 1);
    assert.ok(new Date(pending.next_at) > new Date(), "backed off");

    // Not due yet → not retried.
    await h.webhook.drain();
    assert.equal(h.webhookCalls.length, 1);

    // Due and VascIQ back → delivered.
    h.setWebhookStatus(200);
    await h.webhook.drain(new Date(Date.now() + 60_000));
    assert.equal(h.webhookCalls.length, 2);
    assert.equal(h.db.oldestPendingWebhook(), null);
  } finally {
    await h.close();
  }
});

test("stops retrying when VascIQ says it does not know the control id", async () => {
  const h = await makeHarness();
  try {
    await h.send({ controlId: "000040", destination: "ccdhb", message: SAMPLE_ORU, testMode: true });
    h.dropInbound("ack.hl7", ackFor("000040"));
    h.setWebhookStatus(404);
    await h.watcher.processOnce();
    assert.equal(h.webhookCalls.length, 1);
    assert.equal(h.db.oldestPendingWebhook(), null, "dropped, not pending");
    assert.equal(h.db.webhookFor("000040").gave_up, 1);
  } finally {
    await h.close();
  }
});
