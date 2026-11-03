import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Local SQLite log (Node's built-in driver — no native build step).
 *   messages       one row per message VascIQ handed us
 *   webhook_queue  ACK reports waiting to reach VascIQ (retried until 2xx)
 *   alerts         last time each alert condition was emailed (cooldown)
 */
export function openDb(dbPath) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists messages (
      control_id   text primary key,
      destination  text not null,
      test_mode    integer not null default 0,
      bytes        integer not null,
      received_at  text not null,
      written_at   text,
      filename     text,
      ack_code     text,
      ack_text     text,
      ack_at       text,
      ack_file     text
    );
    create table if not exists webhook_queue (
      id           integer primary key autoincrement,
      control_id   text not null,
      payload      text not null,
      attempts     integer not null default 0,
      next_at      text not null,
      created_at   text not null,
      delivered_at text,
      last_error   text,
      gave_up      integer not null default 0
    );
    create index if not exists webhook_queue_pending_idx
      on webhook_queue (delivered_at, gave_up, next_at);
    create table if not exists alerts (
      key          text primary key,
      last_sent_at text not null
    );
  `);

  const now = () => new Date().toISOString();

  return {
    raw: db,

    // -- messages --------------------------------------------------------
    getMessage(controlId) {
      return db.prepare("select * from messages where control_id = ?").get(controlId) ?? null;
    },
    recordReceived({ controlId, destination, testMode, bytes }) {
      db.prepare(
        `insert into messages (control_id, destination, test_mode, bytes, received_at)
         values (?, ?, ?, ?, ?)
         on conflict (control_id) do nothing`
      ).run(controlId, destination, testMode ? 1 : 0, bytes, now());
    },
    recordWritten(controlId, filename) {
      db.prepare("update messages set written_at = ?, filename = ? where control_id = ?").run(
        now(),
        filename,
        controlId
      );
    },
    recordAck(controlId, { ackCode, ackText, file }) {
      db.prepare(
        "update messages set ack_code = ?, ack_text = ?, ack_at = ?, ack_file = ? where control_id = ?"
      ).run(ackCode, ackText ?? null, now(), file ?? null, controlId);
    },
    countMessages() {
      return db.prepare("select count(*) as n from messages").get().n;
    },

    // -- webhook queue ---------------------------------------------------
    enqueueWebhook(controlId, payload) {
      const t = now();
      db.prepare(
        "insert into webhook_queue (control_id, payload, next_at, created_at) values (?, ?, ?, ?)"
      ).run(controlId, JSON.stringify(payload), t, t);
    },
    dueWebhooks(at = now()) {
      return db
        .prepare(
          `select * from webhook_queue
           where delivered_at is null and gave_up = 0 and next_at <= ?
           order by id limit 50`
        )
        .all(at)
        .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    },
    markWebhookDelivered(id) {
      db.prepare("update webhook_queue set delivered_at = ?, last_error = null where id = ?").run(
        now(),
        id
      );
      const row = db.prepare("select control_id from webhook_queue where id = ?").get(id);
      if (row) {
        db.prepare("update messages set ack_text = ack_text where control_id = ?").run(row.control_id);
      }
    },
    markWebhookFailed(id, { attempts, nextAt, error, gaveUp = false }) {
      db.prepare(
        "update webhook_queue set attempts = ?, next_at = ?, last_error = ?, gave_up = ? where id = ?"
      ).run(attempts, nextAt, error, gaveUp ? 1 : 0, id);
    },
    oldestPendingWebhook() {
      return (
        db
          .prepare(
            `select * from webhook_queue where delivered_at is null and gave_up = 0
             order by created_at limit 1`
          )
          .get() ?? null
      );
    },
    webhookFor(controlId) {
      return (
        db
          .prepare("select * from webhook_queue where control_id = ? order by id desc limit 1")
          .get(controlId) ?? null
      );
    },

    // -- alerts ----------------------------------------------------------
    alertLastSent(key) {
      return db.prepare("select last_sent_at from alerts where key = ?").get(key)?.last_sent_at ?? null;
    },
    alertSent(key) {
      db.prepare(
        "insert into alerts (key, last_sent_at) values (?, ?) on conflict (key) do update set last_sent_at = excluded.last_sent_at"
      ).run(key, now());
    },
    alertCleared(key) {
      db.prepare("delete from alerts where key = ?").run(key);
    },

    close() {
      db.close();
    },
  };
}
