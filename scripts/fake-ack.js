/**
 * Dev helper: drop a fake HealthLink ACK into HL7_in for a control id,
 * as the HMS client would. Lets the whole VascIQ → sender → webhook path
 * be exercised before HealthLink exists.
 *
 *   npm run fake-ack -- 000002            # AA
 *   npm run fake-ack -- 000002 AE "PID-3 unknown NHI"
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";

const [controlId, code = "AA", ...textParts] = process.argv.slice(2);
if (!controlId) {
  console.error("usage: fake-ack <controlId> [AA|AE|AR] [text]");
  process.exit(1);
}
const config = loadConfig();
const text = textParts.join(" ");
const ts = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const ack =
  [
    `MSH|^~\\&|HEALTHLINK|ccoastst|PULSEIQ|pulseus|${ts}||ACK|${Date.now().toString().slice(-6)}|P|2.1`,
    `MSA|${code}|${controlId}${text ? `|${text}` : ""}`,
  ].join("\r") + "\r";

fs.mkdirSync(config.hl7In, { recursive: true });
const file = path.join(config.hl7In, `ACK_${controlId}_${Date.now()}.hl7`);
fs.writeFileSync(file, ack);
console.log(`wrote ${file}`);
