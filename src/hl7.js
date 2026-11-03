/**
 * Just enough HL7 v2 parsing to recognise an ACK and read who it is for.
 * Segments may be separated by CR, LF or CRLF; fields by "|".
 */

export function parseSegments(text) {
  return String(text ?? "")
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split("|"));
}

/**
 * HL7 field number → array index. MSH is special: MSH-1 is the "|"
 * itself, so MSH-2 lives at index 1, MSH-9 at index 8. Every other
 * segment's field n is at index n.
 */
export function field(segment, n) {
  if (!segment) return "";
  const idx = segment[0] === "MSH" ? n - 1 : n;
  return segment[idx] ?? "";
}

/**
 * Inspect a file from HL7_in.
 *   { isAck: true, ackCode, controlId, text, messageType, messageControlId }
 *   { isAck: false, messageType }
 */
export function parseAck(text) {
  const segments = parseSegments(text);
  const msh = segments.find((s) => s[0] === "MSH");
  const messageType = field(msh, 9).split("^")[0] || "";
  const messageControlId = field(msh, 10);
  const msa = segments.find((s) => s[0] === "MSA");

  if (!msa) return { isAck: false, messageType, messageControlId };

  const err = segments.find((s) => s[0] === "ERR");
  const ackText = [field(msa, 3), err ? err.slice(1).join("|") : ""]
    .map((t) => t.trim())
    .filter(Boolean)
    .join(" | ");

  return {
    isAck: true,
    messageType,
    messageControlId,
    ackCode: field(msa, 1).toUpperCase(),
    controlId: field(msa, 2).trim(),
    text: ackText,
  };
}

/** True for the codes VascIQ understands. Anything else is logged and filed. */
export function isKnownAckCode(code) {
  return code === "AA" || code === "AE" || code === "AR";
}
