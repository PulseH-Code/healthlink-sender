import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, SAMPLE_ORU } from "./helpers.js";

test("/send writes the exact bytes it received to HL7_out via atomic rename", async () => {
  const h = await makeHarness();
  try {
    const res = await h.send({ controlId: "000001", destination: "ccdhb", message: SAMPLE_ORU, testMode: true });
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { ok: true, controlId: "000001", filename: "000001.hl7", duplicate: false });

    const written = fs.readFileSync(path.join(h.hl7Out, "000001.hl7"));
    assert.equal(written.toString("utf8"), SAMPLE_ORU);
    assert.equal(written[written.length - 1], 0x0d, "file ends with CR");
    assert.ok(!written.includes(0x0a), "no LF in file");

    // Nothing left behind in staging; nothing else in HL7_out.
    assert.deepEqual(fs.readdirSync(h.config.staging), []);
    assert.deepEqual(fs.readdirSync(h.hl7Out), ["000001.hl7"]);

    const row = h.db.getMessage("000001");
    assert.equal(row.destination, "ccdhb");
    assert.equal(row.test_mode, 1);
    assert.ok(row.received_at && row.written_at);
    assert.equal(row.filename, "000001.hl7");
  } finally {
    await h.close();
  }
});

test("/send is idempotent for a retried control id", async () => {
  const h = await makeHarness();
  try {
    await h.send({ controlId: "000002", destination: "ccdhb", message: SAMPLE_ORU, testMode: false });
    const again = await h.send({ controlId: "000002", destination: "ccdhb", message: SAMPLE_ORU + "X", testMode: false });
    assert.equal(again.status, 202);
    assert.equal(again.body.duplicate, true);
    assert.equal(fs.readFileSync(path.join(h.hl7Out, "000002.hl7"), "utf8"), SAMPLE_ORU, "original bytes kept");
  } finally {
    await h.close();
  }
});

test("/send rejects a missing or wrong API key and bad bodies", async () => {
  const h = await makeHarness();
  try {
    assert.equal((await h.send({ controlId: "1", destination: "ccdhb", message: SAMPLE_ORU }, null)).status, 401);
    assert.equal((await h.send({ controlId: "1", destination: "ccdhb", message: SAMPLE_ORU }, "wrong")).status, 401);
    assert.equal((await h.send("not json")).status, 400);
    assert.equal((await h.send({ controlId: "../evil", destination: "ccdhb", message: SAMPLE_ORU })).status, 400);
    assert.equal((await h.send({ controlId: "3", destination: "", message: SAMPLE_ORU })).status, 400);
    assert.equal((await h.send({ controlId: "3", destination: "ccdhb", message: "hello" })).status, 400);
    assert.deepEqual(fs.readdirSync(h.hl7Out), []);
  } finally {
    await h.close();
  }
});

test("/status and /health report what the service knows", async () => {
  const h = await makeHarness();
  try {
    await h.send({ controlId: "000003", destination: "ccdhb", message: SAMPLE_ORU, testMode: true });
    const status = await h.get("/status/000003");
    assert.equal(status.status, 200);
    assert.equal(status.body.filename, "000003.hl7");
    assert.equal(status.body.acked, false);
    assert.equal((await h.get("/status/nope")).status, 404);
    assert.equal((await h.get("/status/000003", null)).status, 401);

    const health = await h.get("/health", null);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.folders.hl7Out.reachable, true);
    assert.equal(health.body.folders.hl7Out.files, 1);
    assert.equal(health.body.folders.hl7In.files, 0);
    assert.equal(health.body.messages, 1);
  } finally {
    await h.close();
  }
});
