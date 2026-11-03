import { test } from "node:test";
import assert from "node:assert/strict";
import { field, parseAck, parseSegments } from "../src/hl7.js";

test("MSH field numbering accounts for the separator field", () => {
  const msh = parseSegments("MSH|^~\\&|APP|EDI|HEALTHLINK|ccoastst|20261102||ACK|12345|P|2.1")[0];
  assert.equal(field(msh, 2), "^~\\&");
  assert.equal(field(msh, 3), "APP");
  assert.equal(field(msh, 9), "ACK");
  assert.equal(field(msh, 10), "12345");
  assert.equal(field(msh, 12), "2.1");
});

test("parses an ACK with MSA text and ERR, whatever the line endings", () => {
  for (const sep of ["\r", "\n", "\r\n"]) {
    const ack = parseAck(["MSH|^~\\&|A|B|C|D|20261102||ACK^R01|1|P|2.1", "MSA|AE|000123|Bad NHI", "ERR|PID^1^3"].join(sep));
    assert.equal(ack.isAck, true);
    assert.equal(ack.messageType, "ACK");
    assert.equal(ack.ackCode, "AE");
    assert.equal(ack.controlId, "000123");
    assert.equal(ack.text, "Bad NHI | PID^1^3");
  }
});

test("recognises a non-ACK message", () => {
  const oru = parseAck("MSH|^~\\&|A|B|C|D|20261102||ORU^R01|1|P|2.1\rPID|1||ABC1234\r");
  assert.equal(oru.isAck, false);
  assert.equal(oru.messageType, "ORU");
  assert.equal(parseAck("").isAck, false);
});
