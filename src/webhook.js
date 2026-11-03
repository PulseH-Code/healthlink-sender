/**
 * Reports ACK results to VascIQ. Each report is queued in SQLite and
 * retried with backoff until VascIQ answers 2xx, so a VascIQ outage never
 * loses an ACK. 400/404 mean VascIQ does not know the message — retrying
 * cannot fix that, so those are logged and dropped.
 */

const MAX_BACKOFF_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export function backoffMs(attempts) {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

export function createWebhookClient({ db, config, log, fetchImpl = fetch }) {
  async function post(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(config.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-secret": config.webhookSecret,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text().catch(() => "");
      return { status: res.status, ok: res.ok, text: text.slice(0, 300) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enqueue(controlId, ackCode, ackText) {
      db.enqueueWebhook(controlId, { controlId, ackCode, ackText: ackText?.trim() ? ackText.trim() : null });
    },

    /** Send everything that is due. Returns counts for logging/tests. */
    async drain(now = new Date()) {
      const due = db.dueWebhooks(now.toISOString());
      const summary = { attempted: 0, delivered: 0, failed: 0, dropped: 0 };
      for (const item of due) {
        summary.attempted++;
        const attempts = item.attempts + 1;
        let result;
        try {
          result = await post(item.payload);
        } catch (err) {
          result = { status: 0, ok: false, text: err?.name === "AbortError" ? "timeout" : String(err?.message ?? err) };
        }

        if (result.ok) {
          db.markWebhookDelivered(item.id);
          summary.delivered++;
          log.info("webhook delivered", { controlId: item.control_id, ackCode: item.payload.ackCode });
          continue;
        }

        const permanent = result.status === 400 || result.status === 404;
        const error = `${result.status || "network"}: ${result.text}`;
        db.markWebhookFailed(item.id, {
          attempts,
          nextAt: new Date(now.getTime() + backoffMs(attempts)).toISOString(),
          error,
          gaveUp: permanent,
        });
        if (permanent) {
          summary.dropped++;
          log.error("webhook rejected by VascIQ — not retrying", { controlId: item.control_id, error });
        } else {
          summary.failed++;
          log.warn("webhook failed — will retry", { controlId: item.control_id, attempts, error });
        }
      }
      return summary;
    },
  };
}
