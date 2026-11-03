import fsp from "node:fs/promises";
import path from "node:path";

const COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Operational alerts, checked once a minute:
 *   folders_unreachable  HL7_out or HL7_in cannot be read
 *   stuck_outbound       a file has sat in HL7_out longer than N minutes
 *                        (the HMS client is not picking up)
 *   webhook_failing      an ACK report has waited longer than N minutes
 * Each condition emails ALERT_EMAIL at most once per 6 hours and logs a
 * recovery line when it clears. Without SMTP settings alerts only log.
 */
export function createAlerts({ db, config, log, mailer = null }) {
  async function folderAges(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const now = Date.now();
    let newest = null;
    let oldest = null;
    for (const e of entries) {
      if (!e.isFile()) continue;
      const stat = await fsp.stat(path.join(dir, e.name));
      const age = now - stat.mtimeMs;
      newest = newest === null ? age : Math.min(newest, age);
      oldest = oldest === null ? age : Math.max(oldest, age);
    }
    return { files: entries.filter((e) => e.isFile()).length, newestAgeMs: newest, oldestAgeMs: oldest };
  }

  /** Folder reachability + ages, also used by /health. */
  async function folderStatus() {
    const status = {};
    for (const [key, dir] of [
      ["hl7Out", config.hl7Out],
      ["hl7In", config.hl7In],
    ]) {
      try {
        status[key] = { path: dir, reachable: true, ...(await folderAges(dir)) };
      } catch (err) {
        status[key] = { path: dir, reachable: false, error: String(err?.message ?? err) };
      }
    }
    return status;
  }

  async function raise(key, subject, body) {
    const last = db.alertLastSent(key);
    if (last && Date.now() - new Date(last).getTime() < COOLDOWN_MS) return false;
    log.error(`ALERT ${key}: ${subject}`, { body });
    if (mailer && config.alertEmail) {
      try {
        await mailer.send({ to: config.alertEmail, subject: `[HealthLink sender] ${subject}`, text: body });
      } catch (err) {
        log.error("alert email failed", { error: String(err?.message ?? err) });
      }
    }
    db.alertSent(key);
    return true;
  }

  function clear(key) {
    if (db.alertLastSent(key)) {
      db.alertCleared(key);
      log.info(`alert cleared: ${key}`);
    }
  }

  async function check(now = Date.now()) {
    const raised = [];
    const folders = await folderStatus();

    const unreachable = Object.entries(folders).filter(([, s]) => !s.reachable);
    if (unreachable.length) {
      if (
        await raise(
          "folders_unreachable",
          "HMS folder not reachable",
          unreachable.map(([k, s]) => `${k}: ${s.path} — ${s.error}`).join("\n")
        )
      )
        raised.push("folders_unreachable");
    } else clear("folders_unreachable");

    const stuckMs = config.stuckFileMinutes * 60_000;
    if (folders.hl7Out.reachable && folders.hl7Out.oldestAgeMs !== null && folders.hl7Out.oldestAgeMs > stuckMs) {
      if (
        await raise(
          "stuck_outbound",
          "HMS client is not picking up messages",
          `${folders.hl7Out.files} file(s) in ${config.hl7Out}; oldest has waited ${Math.round(
            folders.hl7Out.oldestAgeMs / 60_000
          )} minutes.`
        )
      )
        raised.push("stuck_outbound");
    } else clear("stuck_outbound");

    const oldest = db.oldestPendingWebhook();
    const failingMs = config.webhookFailingMinutes * 60_000;
    if (oldest && now - new Date(oldest.created_at).getTime() > failingMs) {
      if (
        await raise(
          "webhook_failing",
          "Cannot report ACKs to VascIQ",
          `Oldest pending report (control id ${oldest.control_id}) created ${oldest.created_at}, ${oldest.attempts} attempt(s), last error: ${oldest.last_error ?? "none yet"}.`
        )
      )
        raised.push("webhook_failing");
    } else clear("webhook_failing");

    return { raised, folders };
  }

  let timer = null;
  return {
    check,
    folderStatus,
    start(intervalMs = 60_000) {
      timer = setInterval(() => check().catch((err) => log.error("alert check failed", { error: String(err) })), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
