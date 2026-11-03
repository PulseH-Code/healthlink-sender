import fs from "node:fs";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { openDb } from "./db.js";
import { createMailer } from "./mailer.js";
import { createWebhookClient } from "./webhook.js";
import { createWatcher } from "./watcher.js";
import { createAlerts } from "./alerts.js";
import { createServer } from "./http.js";

/**
 * HealthLink sender service. Everything VascIQ needs from the Windows VM:
 * an HTTPS endpoint that drops messages into the HMS client's HL7_out,
 * a watcher that matches ACKs in HL7_in to those messages and reports
 * them to VascIQ, and alerts when any of that stops moving.
 */
async function main() {
  const config = loadConfig();
  const log = createLogger(config.logPath);
  log.info("starting HealthLink sender", {
    hl7Out: config.hl7Out,
    hl7In: config.hl7In,
    staging: config.staging,
    webhook: config.webhookUrl,
    tls: Boolean(config.tls),
    alerts: config.alertEmail ? (config.smtp ? "email" : "log only (no SMTP)") : "off",
  });

  // Our own folders only. The HMS client owns HL7_out\<TYPE> and
  // HL7_in\<TYPE>; if they are missing the config points at the wrong
  // message type and /health says so rather than us inventing folders.
  for (const dir of [config.staging, config.archive]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = openDb(config.dbPath);
  const mailer = createMailer(config);
  const webhook = createWebhookClient({ db, config, log });
  const watcher = createWatcher({ db, config, log, webhook });
  const alerts = createAlerts({ db, config, log, mailer });
  const api = createServer({ db, config, log, alerts });

  await api.listen();
  watcher.start();
  alerts.start();

  const shutdown = async (signal) => {
    log.info(`shutting down (${signal})`);
    watcher.stop();
    alerts.stop();
    await api.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`${new Date().toISOString()} FATAL ${err?.stack ?? err}`);
  process.exit(1);
});
