import fs from "node:fs";
import path from "node:path";

/**
 * Minimal logger: one timestamped line per event to stdout (captured by
 * the service manager) and appended to a log file.
 */
export function createLogger(logPath) {
  if (logPath) fs.mkdirSync(path.dirname(logPath), { recursive: true });

  function write(level, message, extra) {
    const line =
      `${new Date().toISOString()} ${level.padEnd(5)} ${message}` +
      (extra && Object.keys(extra).length ? " " + JSON.stringify(extra) : "");
    (level === "ERROR" ? console.error : console.log)(line);
    if (logPath) {
      try {
        fs.appendFileSync(logPath, line + "\n");
      } catch {
        // Never let logging take the service down.
      }
    }
  }

  return {
    info: (m, e) => write("INFO", m, e),
    warn: (m, e) => write("WARN", m, e),
    error: (m, e) => write("ERROR", m, e),
  };
}

export const silentLogger = { info() {}, warn() {}, error() {} };
