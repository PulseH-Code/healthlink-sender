# HealthLink sender

The bridge between VascIQ (Next.js on Vercel) and the HealthLink HMS client
on a Windows VM. VascIQ builds HL7 ORU^R01 report messages; this service
puts them where the HMS client picks them up and reports the hospital's
acknowledgement back. It knows nothing about reports or patients: it moves
files and keeps a log.

```
VascIQ ──POST /send──▶ sender ──writes──▶ HL7_out ──HMS client──▶ HealthLink ──▶ hospital
VascIQ ◀──POST /api/delivery/ack── sender ◀──watches── HL7_in ◀──HMS client──◀ ACK
```

## How the HMS client is laid out

The HealthLink client (v6.8, installed to `C:\HLINK`, configured by
`hms_config.xml`) keeps **one folder per message type**, under the user's
EDI. For an HL7 type called `<TYPE>`:

| Folder | In the config | Meaning |
|---|---|---|
| `HL7_out\<TYPE>` | `processDir` | we drop messages here; the client collects them |
| `HL7_out\<TYPE>\rejected` | `processErrorDir` | files the client refused to send |
| `HL7_in\<TYPE>` | `deprocessDir` / `deprocessAckDir` | inbound messages **and ACKs** land here |
| `HL7_in\<TYPE>\rejected` | `deprocessErrorDir` | inbound it could not read |

`HL7_OUT_PATH` and `HL7_IN_PATH` must point at the `<TYPE>` folders, not the
bare `HL7_out` / `HL7_in`. HealthLink tells us which message type our ORU
results use and adds it to the config with the EDI; the folders then exist.
Our own staging and archive folders live beside the client's tree
(`C:\HLINK\vasciq-staging`, `C:\HLINK\vasciq-archive`), never inside the
folders it watches.

## What it does

- **`POST /send`** (header `x-api-key`): body `{ controlId, destination, message, testMode }`.
  Writes `message` byte-for-byte to `<HL7_out>/<controlId>.hl7` — written fully
  to the staging folder first, then renamed in, so the HMS client never reads a
  half-written file. Answers `202`. A repeat of the same `controlId` (VascIQ
  retrying after a lost reply) is accepted without rewriting.
- **`GET /status/:controlId`** (header `x-api-key`): received / written / ACK
  code and text / whether VascIQ has been told.
- **`GET /health`** (no auth): `ok`, whether `HL7_out` and `HL7_in` are
  reachable, how many files sit in each and how old they are.
- **ACK watcher**, every 30 s over `HL7_in\<TYPE>`: a file with an `MSA` segment
  whose `MSA-2` matches a message we sent is recorded (`MSA-1` = AA / AE / AR,
  plus any `MSA-3` / `ERR` text), reported to VascIQ, and archived under
  `vasciq-archive\processed\YYYY-MM-DD\`. Anything else (test messages,
  broadcasts, ACKs for unknown ids) goes to `vasciq-archive\other\`.
- **Rejected-folder watcher**: a message the client moved to
  `HL7_out\<TYPE>\rejected` will never be sent, so it is reported to VascIQ as
  `AR` ("rejected by the HealthLink client") and archived under
  `vasciq-archive\rejected\<date>\`. Files in `HL7_in\<TYPE>\rejected` are
  logged and archived under `other\`. Nothing is ever deleted.
- **Webhook to VascIQ** with the shared secret, retried with backoff (30 s
  doubling to 10 min) until VascIQ answers 2xx. A `400`/`404` from VascIQ means
  it does not know the message, so that report is logged and dropped.
- **Alerts** (email, once per 6 h per condition, recovery logged): a folder is
  unreachable; a file has sat in `HL7_out` for more than 30 min (HMS client not
  collecting); an ACK report has failed to reach VascIQ for more than 15 min.
- **Local log** in SQLite (`data/sender.db`) and a text log (`logs/sender.log`).

## Running it

Needs Node 22.13 or newer (built-in SQLite). One dependency, `nodemailer`.

```bash
npm install
copy .env.example .env      # then fill it in
npm start
```

`.env` keys: `HL7_OUT_PATH`, `HL7_IN_PATH`, `API_KEY`, `VASCIQ_WEBHOOK_URL`,
`VASCIQ_WEBHOOK_SECRET`, `ALERT_EMAIL`, `PORT`, plus SMTP settings for alert
email and optional `TLS_CERT_PATH` / `TLS_KEY_PATH`. `API_KEY` must equal
VascIQ's `HEALTHLINK_SENDER_API_KEY`; `VASCIQ_WEBHOOK_SECRET` must equal its
`HEALTHLINK_WEBHOOK_SECRET`.

### Local test with fake folders

Point `HL7_OUT_PATH` and `HL7_IN_PATH` at two empty folders laid out like the
client's (for example `C:\hl-test\HL7_out\TEST` and `C:\hl-test\HL7_in\TEST`),
start the service, and put its URL in VascIQ → Settings → Hospital delivery.
Sign a report with a hospital destination; `<HL7_out>/<controlId>.hl7` appears.
Then fake the hospital's answer:

```bash
npm run fake-ack -- 000002            # AA → VascIQ shows Delivered
npm run fake-ack -- 000003 AE "PID-3 unknown NHI"   # → Rejected with text
```

Within 30 s the file is matched, filed under `processed/`, and VascIQ's
delivery record updates.

### Tests

```bash
npm test
```

Spins up the HTTP server, fake HMS folders in a temp directory, an in-memory
database and a fake VascIQ webhook. No HealthLink needed.

## Production (Windows Server VM in AWS)

1. Small Windows Server VM (t3.small) in the same VPC as the Elixir boxes.
   Security group: 443 in from the internet (Vercel has no fixed egress IPs),
   RDP from the office IP only.
2. Install Node (LTS), clone this repo to `C:\healthlink-sender`,
   `npm install --omit=dev`, create `.env`.
3. HTTPS: either a certificate on the box (`TLS_CERT_PATH` / `TLS_KEY_PATH`,
   `PORT=443`) or an Application Load Balancer terminating TLS in front of
   `PORT=8443` with `HOST=0.0.0.0` restricted to the ALB's security group.
4. Install the HealthLink HMS client with the Pulse Ultrasound EDI. Open
   `C:\HLINK\hms_config.xml`, find the `messageType` HealthLink added for our
   ORU results, and put its `processDir` and `deprocessAckDir` into `.env`
   as `HL7_OUT_PATH` / `HL7_IN_PATH`. Staging and archive default to
   `C:\HLINK\vasciq-*` (same drive, required for the atomic rename).

   Still to confirm with HealthLink: the message type name for ORU results;
   whether `.hl7` is an acceptable file extension in `processDir`; whether the
   client deletes collected files or moves them (affects the stuck-file
   alert); and whether `pulsehnz` in the installed config is the Pulse EDI.
5. Install as a service with [NSSM](https://nssm.cc) (run as Administrator):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
   ```

   It restarts on failure and on boot; stdout/stderr go to `logs\`.
6. Check `https://<host>/health`, then put `https://<host>` into VascIQ →
   Settings → Hospital delivery → Sender service base URL.

## Layout

```
src/index.js     boot: config, db, server, watcher, alerts
src/config.js    .env → validated config
src/http.js      /send, /status/:id, /health
src/outbox.js    atomic write into HL7_out
src/watcher.js   HL7_in polling, matching, filing
src/hl7.js       segment/field parsing, ACK detection
src/webhook.js   report-to-VascIQ queue with backoff
src/alerts.js    folder / stuck-file / webhook checks + email
src/db.js        SQLite schema (node:sqlite)
scripts/         fake-ack dev helper, NSSM install
test/            node:test suite
```
