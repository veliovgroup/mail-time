[support](https://github.com/sponsors/dr-dimitru)
[support](https://paypal.me/veliovgroup)

# MailTime

[![npm version](https://img.shields.io/npm/v/mail-time.svg?label=mail-time)](https://www.npmjs.com/package/mail-time)
[![CI](https://img.shields.io/github/actions/workflow/status/veliovgroup/mail-time/ci.yml?branch=master)](https://github.com/veliovgroup/mail-time/actions)
[![license](https://img.shields.io/npm/l/mail-time.svg)](LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/dr-dimitru?label=Sponsor)](https://github.com/sponsors/dr-dimitru)

Bulletproof email queue for [horizontally scaled](#sending-emails-from-a-cluster) Node.js & Bun apps. Built on top of [`nodemailer`](https://github.com/nodemailer/nodemailer) and [`josk`](https://github.com/veliovgroup/josk). Single runtime dependency, ESM + CJS, full TypeScript declarations.

`MailTime` runs in one of two modes:

- **`server`** — drains the queue and sends emails via SMTP. The cluster-aware lease guarantees exactly one server sends each email even when many are running.
- **`client`** — only enqueues emails. Use for app servers in a "dedicated mail micro-service" topology.

Many clients + one or more servers coexist behind the same `prefix` in the same store.

## Features

- 🏢 **Horizontally scaled** — synchronize one queue across N processes/hosts/DCs.
- 🔁 **Multi-SMTP rotation** — `backup` (failover) and `balancer` (round-robin) strategies.
- 💪 **Built-in retries** — storage-backed retry with per-letter transport pinning.
- 🎯 **Per-recipient retries** — when a multi-`to` send is partially rejected, only the un-accepted addresses are retried; delivered ones never see a duplicate.
- 📮 **Email concatenation** — fold same-`to` emails arriving inside a window into one letter.
- 🎛️ **One-line setup** — built-in [presets](#settings-presets) for `transactional`, `otp`, `newsletter`, `marketing`, `notifications`, `alerts`.
- 🛢️ **Three first-party storages** — MongoDB, Redis, PostgreSQL. Plus a [custom-adapter contract](https://github.com/veliovgroup/mail-time/blob/master/docs/queue-api.md).
- 📦 **Bun ≥ 1.1.0 & Node ≥ 20.9.0** — same code, both runtimes.
- 🤖 **Ships with AI agent skills** — see [AI agent skills](#ai-agent-skills) below.
- 📐 **Hand-tuned ESM + CJS + TypeScript declarations**.
- 🧪 **95%+ Jest coverage** (85% threshold enforced) + Mocha integration tests for every adapter.

## How it works

### Single point of failure

```ascii
|----------------|         |------|         |------------------|
|  Other mailer  | ------> | SMTP | ------> |  ^_^ Happy user  |
|----------------|         |------|         |------------------|

The scheme above works only as long as SMTP is up.

|----------------|  \ /    |------|         |------------------|
|  Other mailer  | --X---> | SMTP | ------> | 0_o Disappointed |
|----------------|  / \    |------|         |------------------|
                     ^- email lost in vain

MailTime keeps every letter in the queue until SMTP confirms delivery.

|----------------|    /    |------|         |------------------|
|   Mail Time    | --X---> | SMTP | ------> |  ^_^ Happy user  |
|---^------------|  /      |------|         |------^-----------|
     \-------------/ ^- We will try later         /
      \- put it back into queue                  /
       \----------Once connection is back ------/
```

### Multiple SMTP providers

`backup` falls over on failure; `balancer` round-robins:

```ascii
                           |--------|
                     /--X--| SMTP 1 |
                    /   ^  |--------|
                   /    \--- Retry with next provider
|----------------|/        |--------|         |------------------|
|   Mail Time    | ---X--> | SMTP 2 |      /->|  ^_^ Happy user  |
|----------------|\   ^    |--------|     /   |------------------|
                   \  \--- Retry         /
                    \      |--------|   /
                     \---->| SMTP 3 |--/
                           |--------|
```

### Sending emails from a cluster

Most apps schedule recurring emails (daily digest, weekly summary). On a single server this is trivial. In a cluster, every node would otherwise send the same email N times. MailTime's lease prevents the duplicate sends.

```ascii
|===================THE=CLUSTER===================| |=QUEUE=|
| |----------|     |----------|     |----------|  | |       |   |--------|
| | MailTime |     | MailTime |     | MailTime |  | |       |-->| SMTP 1 |------\
| | Server 1 |     | Server 2 |     | Server 3 |  | |       |   |--------|       \
| |-----\----|     |----\-----|     |----\-----|  | |       |                |-------------|
|        \---------------\----------------\---------->      |   |--------|   |     ^_^     |
|                                                 | |       |-->| SMTP 2 |-->| Happy users |
| Each "App Server"                               | |       |   |--------|   |-------------|
| runs MailTime as a "Server"                     | |       |                    /
| for the maximum durability                      | |       |   |--------|      /
|                                                 | |       |-->| SMTP 3 |-----/
|                                                 | |       |   |--------|
|=================================================| |=======|
```

For a dedicated mail machine (rDNS / PTR records), use `type: 'client'` on app servers and a single `type: 'server'` micro-service:

```ascii
|===================THE=CLUSTER===================| |=QUEUE=| |===Mail=Time===|
| |----------|     |----------|     |----------|  | |       | |               |   |--------|
| | MailTime |     | MailTime |     | MailTime |  | |       | | Micro-service |-->| SMTP 1 |------\
| | Client 1 |     | Client 2 |     | Client 3 |  | |       | | running       |   |--------|       \
| |-----\----|     |----\-----|     |----\-----|  | |       | | MailTime as   |                |-------------|
|        \---------------\----------------\---------->      | | "Server" only |   |--------|   |     ^_^     |
|                                                 | |       | | sending       |-->| SMTP 2 |-->| Happy users |
| Each "App" runs MailTime as                     | |       | | emails        |   |--------|   |-------------|
| a "Client" only placing emails to the queue.    | |    <--------            |                    /
|                                                 | |    -------->            |   |--------|      /
|                                                 | |       | |               |-->| SMTP 3 |-----/
|                                                 | |       | |               |   |--------|
|=================================================| |=======| |===============|
```

See [docs/multi-instance.md](https://github.com/veliovgroup/mail-time/blob/master/docs/multi-instance.md) and [docs/dedicated-mail-host.md](https://github.com/veliovgroup/mail-time/blob/master/docs/dedicated-mail-host.md) for full topologies.

## Installation

```sh
npm install --save mail-time nodemailer
# pick at least one storage driver:
npm install --save redis        # for RedisQueue
npm install --save mongodb      # for MongoQueue
npm install --save pg           # for PostgresQueue

# Bun:
bun add mail-time nodemailer
```

> [!NOTE]
> `nodemailer` and adapter drivers are peers (not bundled) so you can pin your own versions.

> [!IMPORTANT]
> Upgrading from v3? See [Migration from 3.x](#migration-from-3x) and the full [v4.0.0 release notes](https://github.com/veliovgroup/mail-time/blob/master/docs/v4.md).

For Meteor.js usage see [docs/meteor.md](https://github.com/veliovgroup/mail-time/blob/master/docs/meteor.md).

## AI agent skills

MailTime ships a Claude / Copilot / Cursor / Codex / Gemini-ready skill bundle. Install it once in your project (or globally) and your AI agent will reach for the right preset, adapter, and pitfall list without you having to paste docs into the chat.

```sh
# Install the MailTime skill into the current project:
npx skills add veliovgroup/mail-time

# Recommended: also install the JoSk skill — MailTime is built on JoSk,
# and deep scheduler questions resolve through JoSk's contract.
npx skills add veliovgroup/josk
```

The `npx skills` CLI ([vercel-labs/skills](https://github.com/vercel-labs/skills)) supports 50+ AI coding agents. Pass `-g` to install user-wide, or `-a claude-code` to target a specific agent. The bundled MailTime skill covers the public API, every queue adapter, the preset table, tuning levers, and common pitfalls — it's the same material as the README and `docs/`, structured for an LLM.

## Quick start

Three things every MailTime needs: a connected storage **client**, one or more **nodemailer transports** (server only), and a **`josk.adapter`** that points at the scheduler storage (server only). Past that, reach for a [preset](#settings-presets) instead of hand-tuning every knob.

### 1. Import

```js
// ESM
import { MailTime, MongoQueue, PostgresQueue, RedisQueue, mailTimePreset } from 'mail-time';

// CommonJS
const { MailTime, MongoQueue, PostgresQueue, RedisQueue, mailTimePreset } = require('mail-time');
```

### 2. Create nodemailer transports

Each transport must expose `.options` (set automatically by `nodemailer.createTransport({...})`). MailTime merges any `options.mailOptions` defaults onto every letter. To produce a `From:` header *from* a transport's `options.from`, set the constructor's `from: (t) => t.options.from` callback (the next example does this). Without that callback, `From:` falls back to per-letter `sendMail({ from })` or `options.mailOptions.from` on the transport itself.

```js
// transports.js
import nodemailer from 'nodemailer';

export const transports = [
  nodemailer.createTransport({
    host: 'smtp.example.com',
    from: 'no-reply@example.com',
    auth: { user: 'no-reply', pass: process.env.SMTP_PASS },
  }),
];
```

### 3. Initialize MailTime with a preset

Pick the preset that matches the email class. Supply your own `queue`, `transports`, `josk.adapter`, and `prefix`. **Setting `prefix` on the constructor propagates into the queue adapter and the JoSk adapter automatically** — no need to repeat it.

```js
// mail-queue.js — transactional emails on Redis
import { MailTime, RedisQueue, mailTimePreset } from 'mail-time';
import { createClient } from 'redis';
import { transports } from './transports.js';

const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();

const mailQueue = new MailTime(mailTimePreset('transactional', {
  type: 'server',
  prefix: 'app',
  queue: new RedisQueue({ client: redisClient }),
  josk: { adapter: { type: 'redis', client: redisClient } },
  transports,
  from: (t) => `"Awesome App" <${t.options.from}>`,
  onSent(email, info) {
    console.log('sent', email.uuid, info);
  },
  onError(error, email, info) {
    console.error('failed', email.uuid, error, info);
  },
}));

await mailQueue.ready();
export { mailQueue };
```

Switching stores is one import change. The same pattern works with `MongoQueue({ db })` + `{ type: 'mongo', db }`, or `PostgresQueue({ client: pgPool })` + `{ type: 'postgres', client: pgPool }`.

### 4. Send and cancel

```js
import { mailQueue } from './mail-queue.js';

const uuid = await mailQueue.sendMail({
  to: 'user@example.com',
  subject: 'You\'ve got an email!',
  text: 'Plain text body',
  html: '<h1>HTML</h1><p>Styled body</p>',
});

// later — cancel before sendAt:
await mailQueue.cancelMail(uuid); // true | false
```

`sendMail` returns a stable `uuid` you can store for cancellation. Pass any [nodemailer message option](https://nodemailer.com/message/) — `to`, `subject`, `text`, `html`, `attachments`, `cc`, `bcc`, custom headers, etc.

### 5. Client-only mode

App servers that only enqueue need no `transports`, no `josk` — just the queue. Use the **same `prefix`** as the server that drains the class.

```js
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';

const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();

export const mailQueue = new MailTime({
  type: 'client',
  prefix: 'app',
  queue: new RedisQueue({ client: redisClient }),
});
```

### 6. Shutdown

```js
process.on('SIGTERM', async () => {
  await mailQueue.drain();   // wait for in-flight SMTPs (optional but recommended)
  mailQueue.destroy();
});
```

`destroy()` is idempotent and stops the scheduler. Always call it from tests.

## Storage layouts

Queue storage and scheduler storage can be the same store or different ones. Use this matrix:

| Queue    | Scheduler (`josk`) | Best for                                     |
| -------- | ------------------ | -------------------------------------------- |
| Postgres | Postgres           | Multi-DC, mixed clocks, strict exactly-once. |
| Redis    | Redis              | High-throughput single-region.               |
| Mongo    | Mongo              | Apps already on Mongo (especially Meteor).   |
| Mongo    | Redis              | Durable letter storage + sub-second polling. |
| Redis    | Mongo              | Hot Redis letters + Mongo for scheduler.     |

For split-store setups pass a different client to each:

```js
const mailQueue = new MailTime({
  prefix: 'app',
  queue:  new MongoQueue({ db }),
  transports,
  josk: {
    adapter: { type: 'redis', client: redisClient },
  },
  /* ... */
});
```

## Settings presets

Each email class wants a different policy — OTP must reach the inbox in seconds, a newsletter wants emails folded together, marketing tolerates retries spread over hours. `mailTimePreset(name, overrides)` applies a vetted shape in one line; you layer your own `queue` / `transports` / `josk.adapter` / `prefix` on top.

```js
import { MailTime, RedisQueue, mailTimePreset } from 'mail-time';

const mailTime = new MailTime(mailTimePreset('otp', {
  prefix: 'otp',
  queue: new RedisQueue({ client: redisClient }),
  transports: [otpTransport],
  josk: { adapter: { type: 'redis', client: redisClient } },
}));
```

| Preset          | Shape                                                                                                                                              | Best for                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `transactional` | `retries: 30`, `retryDelay: 10s`, `concatEmails: false`, `concurrency: 1`, `josk.zombieTime: 120s`                                                 | Receipts, password resets, account changes, welcome emails.                             |
| `otp`           | `retries: 5`, `retryDelay: 2s`, snappy `revolvingInterval: 1024` + jitter `256/1024`, `concurrency: 4`, `sendingTimeout: 60s`                      | Sign-in codes, 2FA, verification codes — stale OTPs aren't worth resending forever.     |
| `newsletter`    | `concatEmails: true` with a 5-minute fold window, `concatSubject: 'Your updates'`, `retries: 5`, `retryDelay: 60s`, `concurrency: 2`, `sendingTimeout: 10min`, `josk.zombieTime: 5min` | Scheduled digests, weekly summaries, "what's new" emails.                               |
| `marketing`     | `retries: 10`, `retryDelay: 30s`, `concatEmails: false`, `concurrency: 5`, `josk.zombieTime: 3min`                                                 | Promotional / campaign blasts where each letter is unique.                              |
| `notifications` | `concatEmails: true` with a 60-second fold window, `concatSubject: 'New activity'`, `retries: 8`, `retryDelay: 30s`, `concurrency: 3`, `josk.zombieTime: 3min` | App / social activity (likes, mentions, follows) where bursts collapse into one letter. |
| `alerts`        | `retries: 20`, `retryDelay: 5s`, snappy `revolvingInterval: 1024` + jitter `256/1024`, `concurrency: 2`, `sendingTimeout: 60s`                     | Ops / admin alerts: monitoring, error reports, escalations.                             |

Presets are equally useful on `type: 'client'` instances — keys that don't apply to the client role are simply ignored.

## Multiple instances (recommended)

**Run one `MailTime` per email class** when policies differ (OTP vs marketing vs receipts). Each class gets its own `MailTime` options and, when policies differ, its own `prefix`. Combine with [presets](#settings-presets) to keep the boilerplate to a single line per class.

- **Same `prefix`** for every `client` and `server` that share one logical queue.
- **Different `prefix`** per class so namespaces don't collide.
- **Never** reuse `prefix` across two instances with different `concatEmails`, `retryDelay`, or other mail policy.

Full example wiring three classes (OTP / transactional / marketing) on one Redis connection, plus app-pod `client` setup, lives in [docs/multi-instance.md](https://github.com/veliovgroup/mail-time/blob/master/docs/multi-instance.md).

## Dedicated mail host

On a **single mail VM** (good rDNS / PTR, fixed SMTP credentials), run **2–8 `server` processes** (~one per CPU core) — typically **one process per email class**. Same `prefix` cluster-wide = one JoSk lease tick at a time, so extra pods on the same `prefix` buy **failover/HA**, not throughput.

Full systemd unit + worker layout: [docs/dedicated-mail-host.md](https://github.com/veliovgroup/mail-time/blob/master/docs/dedicated-mail-host.md).

## Tuning

Defaults fit moderate traffic in a single region. Reach for a [preset](#settings-presets) first; tune individual knobs only when the preset doesn't cover your case. Full guide: [docs/tuning.md](https://github.com/veliovgroup/mail-time/blob/master/docs/tuning.md).

### Option reference (when to touch)

| Option                                         | Default          | Change when                                                                                                                        |
| ---------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                                         | `'batch'`        | `'one'` to claim a single row per tick (fairness over throughput across cluster nodes)                                             |
| `concurrency`                                  | `1`              | Raise to send N emails in parallel per instance. Bounded by your SMTP / API rate limits. The CAS on `isSending` keeps it safe.     |
| `sendingTimeout`                               | `300000` (5 min) | Stale-lock recovery window. Must exceed worst-case SMTP roundtrip; lower it only when you're confident sends never take that long. |
| `revolvingInterval`                            | `1536` ms        | Lower → faster pickup; higher → less scheduler I/O                                                                                 |
| `josk.minRevolvingDelay` / `maxRevolvingDelay` | `512` / `2048`   | Lower both → snappier polls, more storage load                                                                                     |
| `josk.zombieTime`                              | `60000`          | **Never below 60s.** Iterate releases the JoSk lease as soon as scanning ends — only a stalled storage scan can blow this.         |
| `josk.concurrency`                             | `Infinity`       | Set `1` if scheduler ticks overlap while `iterate` still runs                                                                      |
| `josk.execute`                                 | `'batch'`        | Usually leave default; MailTime only registers one JoSk task per instance                                                          |
| `josk.lockOwnerId`                             | random           | Set in production for observability                                                                                                |
| `retries` / `retryDelay`                       | `59` / `60s`     | `retries` is *after* the first attempt; default `59` means 60 total attempts. Per email class — transactional shorter, marketing longer. |
| `concatEmails` / `concatDelay`                 | `false` / `60s`  | On for notification batching; off for OTP and receipts                                                                             |
| `prefix`                                       | `''`             | **Same** on all `client` + `server` for one queue; **different** only per email class / shard                                      |

For deeper JoSk semantics (lease lifecycle, scheduler adapters, recurring tasks), install the JoSk skill: **`npx skills add veliovgroup/josk`**.

## Templates

Two Mustache-like placeholder forms:

- `{{key}}` — string interpolation, strips HTML from the value (safe for plain text).
- `{{{key}}}` — raw HTML interpolation.

Every `sendMail` option is available inside `text`, `html`, and the wrapping template:

```js
const layouts = {
  envelope: `<html><body>{{{html}}}<footer>Sent to @{{username}} ({{to}})</footer></body></html>`,
  otp: {
    text: 'Hello @{{username}}! Your code: {{code}}',
    html: '<h1>Sign-in</h1><p>Hello <b>@{{username}}</b></p><pre><code>{{code}}</code></pre>',
  },
};

const mailQueue = new MailTime({
  /* ... */
  template: layouts.envelope,
});

await mailQueue.sendMail({
  to: 'user@example.com',
  subject: 'Sign-in code',
  username: 'mike',
  code: 'A1B2-C3D4',
  text: layouts.otp.text,
  html: layouts.otp.html,
});
```

`MailTime.Template` is a bundled responsive HTML envelope you can use as the default — set it on the constructor or per-letter via `opts.template`.

## API

### `new MailTime(opts)`

| Option                        | Type                                                | Default                    | Notes                                                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue`                       | `MongoQueue \| RedisQueue \| PostgresQueue \| CustomQueue` | —                    | **Required.** Storage adapter for letters. Custom adapters: see [docs/queue-api.md](https://github.com/veliovgroup/mail-time/blob/master/docs/queue-api.md).                                                                                     |
| `type`                        | `'server' \| 'client'`                              | `'server'`                 | `'client'` only enqueues — no `transports` / `josk` required.                                                                                                                               |
| `transports`                  | `nodemailer.Transport[]`                            | —                          | **Required for `server`**. Non-empty.                                                                                                                                                       |
| `josk`                        | `MailTimeJoSkOptions`                               | —                          | **Required for `server`**. See [JoSk options](#josk-options) below.                                                                                                                         |
| `strategy`                    | `'backup' \| 'balancer'`                            | `'backup'`                 | Multi-SMTP rotation policy.                                                                                                                                                                 |
| `failsToNext`                 | `number`                                            | `4`                        | (`backup`) failures-in-a-row before rotating.                                                                                                                                               |
| `retries`                     | `number`                                            | `59`                       | Re-send attempts after first failure. Total attempts = `retries + 1` (defaults to 60). Legacy alias `maxTries` is honored when `retries` is absent: `new MailTime({ maxTries: N })` sets total attempts to `N`.                |
| `retryDelay`                  | `number` (ms)                                       | `60000`                    | Wait between attempts.                                                                                                                                                                      |
| `keepHistory`                 | `boolean`                                           | `false`                    | Keep sent/failed/cancelled rows.                                                                                                                                                            |
| `concatEmails`                | `boolean \| { subject?: string }`                   | `false`                    | Fold same-`to` letters into one. Pass `{ subject: 'X' }` to set the folded-letter subject inline; the string supports the `{{count}}` placeholder and overrides `concatSubject`.            |
| `concatSubject`               | `string`                                            | `'Multiple notifications'` | Subject when folded. Supports `{{count}}` for the folded letter count.                                                                                                                      |
| `concatDelimiter`             | `string`                                            | `'<hr>'`                   | Separator between folded bodies.                                                                                                                                                            |
| `concatDelay`                 | `number` (ms)                                       | `60000`                    | Fold window.                                                                                                                                                                                |
| `revolvingInterval`           | `number` (ms)                                       | `1536`                     | Queue iteration interval.                                                                                                                                                                   |
| `mode`                        | `'one' \| 'batch'`                                  | `'batch'`                  | `'batch'` claims every due row per tick; `'one'` claims a single row per tick.                                                                                                              |
| `concurrency`                 | `number`                                            | `1`                        | Parallel SMTPs per instance. The CAS on `isSending` prevents duplicate delivery.                                                                                                            |
| `sendingTimeout`              | `number` (ms)                                       | `300000`                   | Window after which a stuck `isSending=true` row becomes eligible again. Must exceed worst-case SMTP roundtrip.                                                                              |
| `verifyTransports`            | `boolean`                                           | `true`                     | Probe each transport via `transport.verify()` once at `ready()`. Failing transports are marked unusable, surfaced through `onError(error, null, { transportIndex, phase: 'verify' })`, and skipped during rotation/fallback. Throws from `ready()` if **every** transport fails. Transports without a `verify()` method are treated as healthy. |
| `template`                    | `string`                                            | `'{{{html}}}'`             | Default envelope.                                                                                                                                                                           |
| `prefix`                      | `string`                                            | `''`                       | Queue namespace. **Same** on every `client` and `server` for one logical queue; **different** per email class. Inherited by the queue adapter; JoSk scheduler uses `mailTimeQueue<prefix>`. |
| `from`                        | `string \| (transport) => string`                   | —                          | Strongly recommended for spam-passing `From:` formatting.                                                                                                                                   |
| `debug`                       | `boolean`                                           | `false`                    | Verbose logs.                                                                                                                                                                               |
| `onSent(email, info)`         | `function`                                          | —                          | Called once the task is fully delivered. `email.mailOptions[i].accepted` lists every address that got through (across all attempts).                                                        |
| `onError(error, email, info)` | `function`                                          | —                          | Called once the retry budget is exhausted with at least one un-accepted recipient. `email.mailOptions[i].rejected` lists each un-delivered address with its last error. Also fires once per transport that fails `verify()` at startup with `email === null` and `info = { transportIndex, phase: 'verify' }`. |

### JoSk options

`opts.josk` is passed to the underlying [`JoSk`](https://github.com/veliovgroup/josk) constructor. Useful keys:

| Key                       | Default           | Notes                                                                                                          |
| ------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `adapter`                 | —                 | Either a constructed adapter or a config object: `{ type: 'redis' \| 'mongo' \| 'postgres', client \| db, prefix?, resetOnInit? }`. MailTime constructs the adapter from the config object. |
| `minRevolvingDelay`       | `512`             | Lower bound of poll window.                                                                                    |
| `maxRevolvingDelay`       | `2048`            | Upper bound.                                                                                                   |
| `zombieTime`              | `60000`           | Re-claim if `queue.iterate()` runs longer than this. **Do not drop below 60s.**                                |
| `execute`                 | `'batch'`         | JoSk scheduler batching; low impact for MailTime (one interval task per instance).                             |
| `concurrency`             | `Infinity`        | Cap overlapping JoSk handler runs on **this** process (`1` if ticks pile up).                                  |
| `autoClear`               | `false`           | Remove orphan tasks from storage.                                                                              |
| `lockOwnerId`             | `josk-<uuid>`     | Stable owner id; recommended per worker.                                                                       |
| `onError(title, details)` | (logs to console) | Wire to your logger.                                                                                           |

For deeper JoSk semantics, install the JoSk skill: **`npx skills add veliovgroup/josk`** (the same author).

### Methods

- `sendMail(opts)` → `Promise<string>` uuid. Throws on missing `to` or on missing both `text` and `html`. Pass any nodemailer message option plus `sendAt` (Date or ms timestamp), `template`, `concatSubject`.
- `send(opts)` — alias of `sendMail`.
- `cancelMail(uuidOrPromise)` → `Promise<boolean>`. Accepts the `uuid` or the `Promise<string>` from `sendMail`.
- `cancel(uuid)` — alias of `cancelMail`.
- `ping()` → `Promise<{status, code, statusCode, error?}>`. Pings scheduler then queue.
- `ready()` → `Promise<MailTime>`. Awaits all startup work; rejects with `.cause` on storage failure.
- `destroy()` → `boolean`. Stops scheduler. Idempotent. Pair with `drain()` for graceful shutdown.
- `drain()` → `Promise<void>`. Resolves once every in-flight SMTP attempt finishes. Useful in tests and graceful-shutdown paths.

### Queue constructors

| Constructor                              | Required option                                      | Optional                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `new RedisQueue({ client, prefix? })`    | connected `redis@^4/^5` client with `watch()` + `multi()` | `prefix` — inherited from `MailTime` when omitted. Redis Cluster prefixes must map to one hash slot.        |
| `new MongoQueue({ db, prefix? })`        | `db` from `MongoClient#db()`                         | `prefix` — inherited from `MailTime` when omitted. Indexes auto-created on first `ready()`.                  |
| `new PostgresQueue({ client, prefix? })` | `pg.Pool` (recommended) or `pg.Client`               | `prefix` — inherited from `MailTime` when omitted. `mail_time_queue` table auto-migrated on first `ready()`. |

For custom adapters see [docs/queue-api.md](https://github.com/veliovgroup/mail-time/blob/master/docs/queue-api.md).

### Module functions

- `mailTimePreset(name, overrides?)` → fresh MailTime constructor config. Deep-clones the named [preset](#settings-presets) and deep-merges your overrides (scalars win, nested `josk` composes). Throws on unknown `name` or non-object `overrides`.
- `presets` — read-only `{ [name]: partialConfig }` map backing `mailTimePreset`.
- `presetNames` — read-only array of preset names.

### Static

- `MailTime.Template` — get/set the default HTML envelope template.

## Migration from 3.x

Full v4 highlights, adapter changes, and type exports live in [docs/v4.md](https://github.com/veliovgroup/mail-time/blob/master/docs/v4.md). Quick checklist:

1. **Node ≥ 20.9.0**, Bun ≥ 1.1.0. Bump your runtime first.
2. **Swap adapter imports** to the new `MongoQueue` / `RedisQueue` / `PostgresQueue` constructors.
3. **Pass `josk`** — it's now required for `type: 'server'`.
4. **`josk.zombieTime` default raised to `60000` ms** (was `32786`). Set it explicitly if you relied on the old value.
5. **Custom queue adapters** — `update`'s claim guard now triggers on `{ isSending: true, sendingAt, tries }` (was `{ isSent: true, tries }`) and must include the stale-lock-recovery clause `(isSending === false OR sendingAt <= now - sendingTimeout)`. The iterate path must call `await mailTimeInstance.___dispatch(row)` instead of `___send` and honor `opts.limit` / `opts.sendingTimeout`. See [docs/queue-api.md](https://github.com/veliovgroup/mail-time/blob/master/docs/queue-api.md) and [`adapters/blank-example.js`](https://github.com/veliovgroup/mail-time/blob/master/adapters/blank-example.js).
6. **Default behavior unchanged** — `concurrency: 1` keeps the post-upgrade send rate identical to v3. Opt into parallel sends by raising `concurrency`.

New v4 surface to opt into: [`mailTimePreset`](#settings-presets), `concurrency`, `mode`, `sendingTimeout`, `drain()`, per-recipient retries, and the [AI agent skills](#ai-agent-skills) bundle.

## Testing

```sh
npm install
# DEFAULT RUN — needs Redis + Mongo + Postgres up locally
REDIS_URL="redis://127.0.0.1:6379" \
MONGO_URL="mongodb://127.0.0.1:27017/mail-time-test" \
PG_URL="postgres://127.0.0.1:5432/postgres" \
  npm test

# Single suite
npm run test:redis
npm run test:mongo
npm run test:postgres

# Bun-native test runner (only Jest-shaped tests)
bun test ./test/jest
```

`npm test` runs Jest unit tests, then Mocha integration tests, then TypeScript declaration tests. Jest coverage threshold is **85%** across statements, branches, functions, and lines. GitHub Actions runs the matrix against `redis@^4` and `redis@^5`.

## Bun

MailTime ships pure ESM with a generated CJS bundle. Both runtimes (Bun ≥ 1.1.0, Node ≥ 20.9.0) load it directly:

```js
import { MailTime } from 'mail-time'; // works in both
```

Mixed clusters (some Node, some Bun) share one schedule under the same `prefix` — the lease lives in storage, runtime-agnostic.

## License

[BSD-3-Clause](LICENSE).

## Support this project

- Star on [GitHub](https://github.com/veliovgroup/mail-time) and [NPM](https://www.npmjs.com/package/mail-time).
- [Sponsor maintainer on GitHub](https://github.com/sponsors/dr-dimitru).
- [Sponsor veliovgroup on GitHub](https://github.com/sponsors/veliovgroup).
- [PayPal](https://paypal.me/veliovgroup).
- Try [☄️ meteor-files.com](https://meteor-files.com/?ref=github-mail-time-repo-footer).
- Try [▲ ostr.io](https://ostr.io?ref=github-mail-time-repo-footer) for server monitoring, web analytics, web-CRON, and SEO pre-rendering.
