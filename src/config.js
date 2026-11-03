import path from "node:path";

const REQUIRED = [
  "HL7_OUT_PATH",
  "HL7_IN_PATH",
  "API_KEY",
  "VASCIQ_WEBHOOK_URL",
  "VASCIQ_WEBHOOK_SECRET",
];

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Read and validate configuration from the environment (.env via
 * `node --env-file`). Throws a readable error listing what is missing so
 * the Windows service log says exactly what to fix.
 */
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const missing = REQUIRED.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const hl7Out = path.resolve(cwd, env.HL7_OUT_PATH);
  const hl7In = path.resolve(cwd, env.HL7_IN_PATH);

  return {
    hl7Out,
    hl7In,
    staging: env.STAGING_PATH
      ? path.resolve(cwd, env.STAGING_PATH)
      : path.join(path.dirname(hl7Out), "hl7-staging"),
    apiKey: env.API_KEY.trim(),
    webhookUrl: env.VASCIQ_WEBHOOK_URL.trim(),
    webhookSecret: env.VASCIQ_WEBHOOK_SECRET.trim(),
    port: num(env.PORT, 8443),
    host: env.HOST?.trim() || "0.0.0.0",
    tls:
      env.TLS_CERT_PATH && env.TLS_KEY_PATH
        ? {
            certPath: path.resolve(cwd, env.TLS_CERT_PATH),
            keyPath: path.resolve(cwd, env.TLS_KEY_PATH),
          }
        : null,
    alertEmail: env.ALERT_EMAIL?.trim() || "",
    smtp: env.SMTP_HOST
      ? {
          host: env.SMTP_HOST.trim(),
          port: num(env.SMTP_PORT, 587),
          user: env.SMTP_USER ?? "",
          pass: env.SMTP_PASS ?? "",
          from: env.SMTP_FROM?.trim() || env.SMTP_USER || "",
        }
      : null,
    watchIntervalMs: num(env.WATCH_INTERVAL_MS, 30_000),
    stuckFileMinutes: num(env.STUCK_FILE_MINUTES, 30),
    webhookFailingMinutes: num(env.WEBHOOK_FAILING_MINUTES, 15),
    dbPath: path.resolve(cwd, env.DB_PATH || path.join("data", "sender.db")),
    logPath: path.resolve(cwd, env.LOG_PATH || path.join("logs", "sender.log")),
  };
}
