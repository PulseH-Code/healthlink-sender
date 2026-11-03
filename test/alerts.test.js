import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ackFor, makeHarness, SAMPLE_ORU } from "./helpers.js";

test("alerts when a file sits in HL7_out too long, once per cooldown, and clears", async () => {
  const h = await makeHarness({ stuckFileMinutes: 1 });
  try {
    await h.send({ controlId: "000050", destination: "ccdhb", message: SAMPLE_ORU, testMode: true });
    let result = await h.alerts.check();
    assert.deepEqual(result.raised, [], "fresh file is fine");

    const file = path.join(h.hl7Out, "000050.hl7");
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(file, old, old);
    result = await h.alerts.check();
    assert.deepEqual(result.raised, ["stuck_outbound"]);
    assert.equal(h.sentMail.length, 1);
    assert.equal(h.sentMail[0].to, "ops@example.test");
    assert.match(h.sentMail[0].subject, /not picking up/);

    result = await h.alerts.check();
    assert.deepEqual(result.raised, [], "cooldown: not emailed again");

    fs.unlinkSync(file); // HMS client picked it up
    result = await h.alerts.check();
    assert.deepEqual(result.raised, []);
    assert.equal(h.db.alertLastSent("stuck_outbound"), null, "cleared");
  } finally {
    await h.close();
  }
});

test("alerts when folders are unreachable and when the webhook keeps failing", async () => {
  const h = await makeHarness({ webhookFailingMinutes: 1 });
  try {
    await h.send({ controlId: "000060", destination: "ccdhb", message: SAMPLE_ORU, testMode: true });
    h.dropInbound("ack.hl7", ackFor("000060"));
    h.setWebhookStatus(503);
    await h.watcher.processOnce();

    let result = await h.alerts.check(Date.now() + 2 * 60_000);
    assert.deepEqual(result.raised, ["webhook_failing"]);
    assert.match(h.sentMail.at(-1).text, /000060/);

    fs.rmSync(h.hl7In, { recursive: true, force: true });
    result = await h.alerts.check(Date.now() + 2 * 60_000);
    assert.ok(result.raised.includes("folders_unreachable"));
    assert.equal(result.folders.hl7In.reachable, false);

    const health = await h.get("/health", null);
    assert.equal(health.status, 503);
    assert.equal(health.body.ok, false);
  } finally {
    await h.close();
  }
});
