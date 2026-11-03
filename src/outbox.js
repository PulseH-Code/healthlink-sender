import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const CONTROL_ID = /^[A-Za-z0-9_-]{1,20}$/;

export function validControlId(id) {
  return typeof id === "string" && CONTROL_ID.test(id);
}

/**
 * Write a message into HL7_out so the HMS client never reads a partial
 * file: full write to the staging folder, fsync, then an atomic rename
 * into HL7_out. Bytes are written exactly as received (the message is
 * already CR-separated and CR-terminated by VascIQ).
 *
 * Returns { filename, duplicate }. If the file already exists in HL7_out
 * (VascIQ retried after a lost 202) nothing is rewritten.
 */
export async function writeMessage({ hl7Out, staging }, controlId, message) {
  if (!validControlId(controlId)) throw new Error("Invalid control id");
  await fsp.mkdir(hl7Out, { recursive: true });
  await fsp.mkdir(staging, { recursive: true });

  const filename = `${controlId}.hl7`;
  const finalPath = path.join(hl7Out, filename);
  if (fs.existsSync(finalPath)) return { filename, duplicate: true };

  const tmpPath = path.join(staging, `${controlId}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fsp.open(tmpPath, "w");
  try {
    await handle.writeFile(message, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmpPath, finalPath);
  return { filename, duplicate: false };
}
