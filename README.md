[support](https://github.com/sponsors/dr-dimitru)
[support](https://paypal.me/veliovgroup)

# MailTime

Bulletproof email queue for [horizontally scaled](#sending-emails-from-a-cluster) Node.js & Bun apps. Built on top of `[nodemailer](https://github.com/nodemailer/nodemailer)` and `[josk](https://github.com/veliovgroup/josk)`. Single runtime dependency, ESM + CJS, full TypeScript declarations.

`MailTime` runs in one of two modes:

- `**server**` — drains the queue and sends emails via SMTP. The cluster-aware lease guarantees exactly one server sends each email even when many are running.
- `**client**` — only enqueues emails. Use for app servers in a "dedicated mail micro-service" topology.

Many clients + one or more servers coexist behind the same `prefix` in the same store.

## Features

- 🏢 **Horizontally scaled** — synchronize one queue across N processes/hosts/DCs.
- 🔁 **Multi-SMTP rotation** — `backup` (failover) and `balancer` (round-robin) strategies.
- 💪 **Built-in retries** — storage-backed retry with per-letter transport pinning.
- 🎯 **Per-recipient retries** — when a multi-`to` send is partially rejected, only the un-accepted addresses are retried; delivered ones never see a duplicate.
- 📮 **Email concatenation** — fold same-`to` emails arriving inside a window into one letter.
- 🛢️ **Three first-party storages** — MongoDB, Redis, PostgreSQL. Plus a custom-adapter contract.
- 📦 **Bun ≥ 1.1.0 & Node ≥ 20.9.0** — same code, both runtimes.
- 👨‍💼 Ships with AI agent skills, install via `npm skills add`
- 📐 **Hand-tuned ESM + CJS + TypeScript declarations**.
- 🧪 **>95% Jest coverage** + mocha integration tests for every adapter.

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
> `nodemailer` and adapter drivers are a peer (not bundled) so you can pin your own versions

For Meteor.js usage see [docs/meteor.md](docs/meteor.md).

## Quick start

### 1. Import

```js
// ESM
import { MailTime, MongoQueue, PostgresQueue, RedisQueue, mailTimePreset } from 'mail-time';

// CommonJS
const { MailTime, MongoQueue, PostgresQueue, RedisQueue, mailTimePreset } = require('mail-time');
```

`mailTimePreset(name, overrides)` is optional — it returns a vetted config bundle you can pass to `new MailTime(...)` instead of hand-tuning every knob. See [Settings presets](#settings-presets).

### 2. Create nodemailer transports

Each transport must expose `.options` (set automatically by `nodemailer.createTransport({...})`). MailTime reads `options.from` and merges any `options.mailOptions` defaults onto every letter.

```js
// transports.js
import nodemailer from 'nodemailer';

const privateSMTP = {
  host: 'smtp.example.com',
  from: 'no-reply@example.com',
  auth: { user: 'no-reply', pass: process.env.SMTP_PASS },
};

const sparkpost = {
  host: 'smtp.sparkpostmail.com',
  port: 587,
  from: 'no-reply@mail.example.com',
  auth: { user: 'SMTP_Injection', pass: process.env.SPARKPOST_PASS },
};

export const transports = [
  nodemailer.createTransport(privateSMTP),
  nodemailer.createTransport(sparkpost),
];
```

### 3. Initialize MailTime

Pick one storage and pass a connected client to the queue + the JoSk adapter. **You only need to set `prefix` on the `MailTime` constructor — it propagates into the queue adapter and into the JoSk adapter automatically.**

#### With Redis

```js
// mail-queue.js
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';
import { transports } from './transports.js';

const redisClient = await createClient({
  url: process.env.REDIS_URL
}).connect();

const joskOptions = {
  adapter: {
    type: 'redis',
    client: redisClient
  }
};

const mailQueue = new MailTime({
  type: 'server',
  prefix: 'app',
  queue: new RedisQueue({ client: redisClient }),
  josk: joskOptions,
  transports,
  template: MailTime.Template,
  from: (transport) => `"Awesome App" <${transport.options.from}>`,
  onSent(email, info) {
    console.log('sent', email.uuid, info);
  },
  onError(error, email, info) {
    console.error('failed', email.uuid, error, info);
  },
});

await mailQueue.ready();
export { mailQueue };
```

#### With MongoDB

```js
import { MailTime, MongoQueue } from 'mail-time';
import { MongoClient } from 'mongodb';
import { transports } from './transports.js';

const db = (await MongoClient.connect(process.env.MONGO_URL)).db('app');

const joskOptions = {
  adapter: { type: 'mongo', db },
};

const mailQueue = new MailTime({
  type: 'server',
  prefix: 'app',
  queue: new MongoQueue({ db }),
  josk: joskOptions,
  transports,
  from: (t) => `"Awesome App" <${t.options.from}>`,
});

await mailQueue.ready();
```

#### With PostgreSQL

```js
import { MailTime, PostgresQueue } from 'mail-time';
import { Pool } from 'pg';
import { transports } from './transports.js';

const pgPool = new Pool({ connectionString: process.env.PG_URL });

const joskOptions = {
  adapter: {
    type: 'postgres',
    client: pgPool
  },
};

const mailQueue = new MailTime({
  type: 'server',
  prefix: 'app',
  queue: new PostgresQueue({ client: pgPool }),
  josk: joskOptions,
  transports,
  from: (t) => `"Awesome App" <${t.options.from}>`,
});

await mailQueue.ready();
```

#### Client-only mode

Only enqueues — no transports, no `josk` block. Use for app servers when sending is handled by a separate micro-service.

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

### 5. Shutdown

```js
process.on('SIGTERM', () => mailQueue.destroy());
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
    adapter: { 
      type: 'redis', 
      client: redisClient 
    }
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
  josk: { 
    adapter: { 
      type: 'redis', 
      client: redisClient 
    }
  },
}));
```


| Preset          | Shape                                                                                                                                                                                  | Best for                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `transactional` | `retries: 30`, `retryDelay: 10s`, `concatEmails: false`, `concurrency: 1`, `josk.zombieTime: 120s`                                                                                     | Receipts, password resets, account changes, welcome emails.                             |
| `otp`           | `retries: 5`, `retryDelay: 2s`, snappy `revolvingInterval: 1024` + jitter `256/1024`, `concurrency: 4`, `sendingTimeout: 60s`                                                          | Sign-in codes, 2FA, verification codes — stale OTPs aren't worth resending forever.     |
| `newsletter`    | `concatEmails: true` with a 5-minute fold window, `concatSubject: 'Your updates'`, `retries: 5`, `retryDelay: 60s`, `concurrency: 2`, `sendingTimeout: 10min`, `josk.zombieTime: 5min` | Scheduled digests, weekly summaries, "what's new" emails.                               |
| `marketing`     | `retries: 10`, `retryDelay: 30s`, `concatEmails: false`, `concurrency: 5`, `josk.zombieTime: 3min`                                                                                     | Promotional / campaign blasts where each letter is unique.                              |
| `notifications` | `concatEmails: true` with a 60-second fold window, `concatSubject: 'New activity'`, `retries: 8`, `retryDelay: 30s`, `concurrency: 3`, `josk.zombieTime: 3min`                         | App / social activity (likes, mentions, follows) where bursts collapse into one letter. |
| `alerts`        | `retries: 20`, `retryDelay: 5s`, snappy `revolvingInterval: 1024` + jitter `256/1024`, `concurrency: 2`, `sendingTimeout: 60s`                                                         | Ops / admin alerts: monitoring, error reports, escalations.                             |


Presets are equally useful on `type: 'client'` instances — keys that don't apply to the client role are simply ignored.

## Multiple MailTime instances (recommended)

**Run several `MailTime` instances when email classes need different policies** (OTP vs marketing vs receipts). Each class gets its own `MailTime` options and, when policies differ, its own `prefix`. Combine with [presets](#settings-presets) to keep the boilerplate to a single line per class.

### `prefix`: when it matches vs when it splits

- **Same `prefix` for every `client` and `server` that share one logical queue** — app pods enqueue with `type: 'client'`, mail workers drain with `type: 'server'`, both use e.g. `prefix: 'otp'`. That is the common case.
- **Different `prefix` per class** so OTP, transactional, and marketing namespaces do not collide.
- **Never** reuse `prefix` across two instances with different `concatEmails`, `retryDelay`, or other mail policy.

You can share one Redis / Mongo / Postgres connection across instances.

```js
import { MailTime, RedisQueue, mailTimePreset } from 'mail-time';
import { createClient } from 'redis';
import { transports, otpTransport, marketingTransport } from './transports.js';

const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();
const adapter = { type: 'redis', client: redisClient };
const lockOwnerId = `${process.env.HOSTNAME || 'mail'}-${process.pid}`;
const queue = () => new RedisQueue({ client: redisClient });

export const otpMail = new MailTime(mailTimePreset('otp', {
  type: 'server', 
  prefix: 'otp',
  queue: queue(), 
  transports: [otpTransport],
  josk: { adapter, lockOwnerId },
  from: (t) => `"Security" <${t.options.from}>`,
}));

export const transactionalMail = new MailTime(mailTimePreset('transactional', {
  type: 'server', 
  prefix: 'transactional',
  queue: queue(), 
  transports,
  josk: { adapter, lockOwnerId },
  from: (t) => `"Awesome App" <${t.options.from}>`,
}));

export const marketingMail = new MailTime(mailTimePreset('newsletter', {
  type: 'server', 
  prefix: 'marketing',
  queue: queue(), 
  transports: [marketingTransport],
  josk: { adapter, lockOwnerId },
  from: (t) => `"News by Awesome App" <${t.options.from}>`,
}));

await Promise.all([otpMail, transactionalMail, marketingMail].map((m) => m.ready()));

// App code picks the right queue:
await otpMail.sendMail({ to: user.email, subject: 'Sign-in code', text: code, html: codeHtml });
await marketingMail.sendMail({ to: user.email, subject: 'New features', text, html });
```

**App servers** use `type: 'client'` with the **same `prefix`** as the mail worker for that class (no `transports`, no `josk`):

```js
// app-server — enqueue only; same prefix as otpMail server above
export const otpClient = new MailTime({
  type: 'client',
  prefix: 'otp',
  queue: new RedisQueue({ client: redisClient }),
});
await otpClient.ready();
await otpClient.sendMail({ to: user.email, subject: 'Sign-in code', text: code });
```

## Dedicated mail host: several servers on one machine

On a **single mail VM** (good rDNS / PTR, fixed SMTP credentials), run **2–8 `server` processes** (~**one per CPU core**). Typical layout: **one process per email class** (`otp`, `transactional`, `marketing`) — each with its own `prefix`. That parallelizes drains across classes. Extra processes with the **same** `prefix` only add **failover** (one JoSk lease winner per tick), not multiplied throughput.

This is **not** the same as scaling app pods on one queue: each `prefix` still has **one cluster-wide drain tick** at a time.

```js
// mail-worker.js — one process per class (example: 3 classes on one host)
import { otpMail, transactionalMail, marketingMail } from './mail-instances.js';

const workers = [otpMail, transactionalMail, marketingMail];
await Promise.all(workers.map((m) => m.ready()));

process.on('SIGTERM', () => {
  for (const m of workers) m.destroy();
});
```

### Parallel `server` processes with systemd

Run each class as its own unit (same `prefix` as app `client` instances for that class). Adjust paths and env to your deploy.

`/etc/systemd/system/mailtime@.service`:

```ini
[Unit]
Description=MailTime server (%i)
After=network-online.target redis.service
Wants=network-online.target

[Service]
Type=simple
Environment=NODE_ENV=production
Environment=REDIS_URL=redis://127.0.0.1:6379
Environment=MAILTIME_CLASS=%i
ExecStart=/usr/bin/node /opt/mailtime/worker.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/opt/mailtime/worker.js` — one class per invocation (`otp`, `transactional`, `marketing`):

```js
import { startMailWorker } from './mail-instances.js';

const mailClass = process.env.MAILTIME_CLASS;
if (!mailClass) {
  throw new Error('MAILTIME_CLASS required (otp | transactional | marketing)');
}

const mailTime = await startMailWorker(mailClass);
process.on('SIGTERM', () => {
  mailTime.destroy();
  process.exit(0);
});
```

Enable and start:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now mailtime@otp mailtime@transactional mailtime@marketing
```

Optional **second unit on the same class** for hot standby (same `prefix`, different `lockOwnerId`) — only one drains per tick; the other takes over if the primary dies.

For **very high volume on one class**, shard with different prefixes (`marketing-0`, `marketing-1`, …) and one systemd instance per shard — not many units on the identical `prefix`.

## Tuning

Defaults fit moderate traffic in a single region. Adjust when latency, volume, or cluster shape demands it.

### How scheduling relates to throughput

MailTime registers **one** JoSk interval per `prefix` (`mailTimeQueue<prefix>` → `queue.iterate()`). Across the cluster, **one `server` wins that lease per tick** — extra app replicas are mainly **failover**, not N× send rate for the same `prefix`.

Inside one server, MailTime now drives sends through a bounded **in-process send pool** (`concurrency`). When a tick fires:

1. `queue.iterate({ limit, sendingTimeout })` streams candidate rows.
2. Each row is handed to `mailTime.___dispatch(row)`, which waits for a free pool slot, atomically claims the row by flipping `isSending=false → true` (with `sendingAt=now`), and starts the full send lifecycle in the background.
3. The scan moves to the next due row as soon as the previous claim has started — the JoSk lease is released as soon as scanning ends, so other ticks (on this or any cluster node) can pick up rows that are still `isSending=false`.
4. The SMTP roundtrip runs detached. On success the row is removed (or marked `isSent: true` with `keepHistory`); on failure `isSending` flips back to `false` and `sendAt` is bumped for the next retry.

`isSending` is the **per-row lock**. The storage-level atomic-claim CAS makes it impossible for two workers — in the same instance or across the cluster — to flip the same row from `false` to `true` at the same `tries` value. A worker that died mid-SMTP leaves the row `isSending=true`; once `sendingAt + sendingTimeout` is in the past, the iterate predicate makes that row eligible again and a recovery worker can re-claim it.

**Throughput levers:**

- More **distinct `prefix`es** (OTP vs marketing, or shards) → more parallel drain loops.
- **Dedicated mail workers** (`type: 'client'` on apps, `type: 'server'` on 1–3 mail hosts) → cleaner SMTP and tuning.
- `**concurrency: N`** (MailTime option) → up to N parallel SMTPs per server instance. The CAS on `isSending` is what makes this safe — two parallel sends never deliver the same row.
- `**mode: 'one' | 'batch'`** (MailTime option) → `'batch'` (default) claims every due row per tick; `'one'` claims a single row per tick (fairer across cluster nodes when one node has dominant scheduling luck).
- `**revolvingInterval`** + `**josk.minRevolvingDelay` / `maxRevolvingDelay**` → how often due mail is picked up (effective delay ≈ interval + jitter + storage RTT).
- **Few fat mail hosts** with several instances (above) → better than dozens of app pods all running `server`.

### Scenario guide

Reach for a [preset](#settings-presets) first; tune only what the preset doesn't cover.


| Situation                            | What to change                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| OTP / alerts                         | `mailTimePreset('otp')` or `mailTimePreset('alerts')`                                                                      |
| Receipts / password resets / welcome | `mailTimePreset('transactional')`                                                                                          |
| Newsletters / activity digests       | `mailTimePreset('newsletter')` or `mailTimePreset('notifications')`                                                        |
| Marketing campaigns                  | `mailTimePreset('marketing')`                                                                                              |
| Multi-DC or clock skew               | Postgres queue + Postgres scheduler; stable `lockOwnerId` per worker                                                       |
| Mongo letters + fast polls           | Mongo `queue`, Redis `josk.adapter` (see [Storage layouts](#storage-layouts))                                              |
| SMTP rate limits                     | Fewer mail workers, `josk.concurrency: 1`, consider `strategy: 'backup'` with real fallback transports                     |
| Large backlog / slow SMTP            | Raise `josk.zombieTime` above worst-case `iterate` duration (Postgres drains up to **100** letters per tick, sequentially) |
| Tests                                | `retries: 0`, `mailTime.destroy()` in teardown; `josk.adapter.resetOnInit: true` dev-only                                  |


### Production JoSk block (any storage)

```js
{
  josk: {
    adapter: { type: 'redis', client: redisClient }, // or mongo / postgres
    lockOwnerId: `${process.env.K8S_POD_NAME || process.env.HOSTNAME}-${process.pid}`,
    onError: (title, details) => logger.error({ scheduler: title, ...details }),
    concurrency: 1,       // optional: prevent overlapping queue.iterate on one worker
    zombieTime: 120_000,  // raise if one tick can run >60s (big backlog × slow SMTP)
  }
}
```

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
| `retries` / `retryDelay`                       | `60` / `60s`     | Per email class; transactional shorter, marketing longer                                                                           |
| `concatEmails` / `concatDelay`                 | `false` / `60s`  | On for notification batching; off for OTP and receipts                                                                             |
| `prefix`                                       | `''`             | **Same** on all `client` + `server` for one queue; **different** only per email class / shard                                      |


### Pitfalls

- Expecting **many `server` pods on the same `prefix`** to multiply throughput — they compete for one drain lease per tick. Use `concurrency` (in-process) and/or distinct `prefix`es (cluster-wide) instead. (Duplicate-prefix `server` is still useful as **failover/HA** — a warm standby with a different `lockOwnerId` takes over the lease the next tick if the leader dies.)
- `zombieTime` too low** with slow storage scans — another node may start an overlapping drain (atomic CAS on `isSending` still prevents double-send, but wasted work and SMTP pressure remain).
- `sendingTimeout` below the worst-case SMTP roundtrip** — a healthy still-sending worker can lose its lock to a recovery worker, causing a duplicate delivery. Always keep `sendingTimeout` comfortably above the slowest legitimate roundtrip.
- **Replica reads** for queue or scheduler — use primary / writer endpoint only.
- `josk.adapter.resetOnInit: true` in production — wipes scheduler state on every boot.

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


| Option                        | Type                     | Default                    | Notes                                                                                                                                                                                       |
| ----------------------------- | ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue`                       | `MongoQueue              | RedisQueue                 | PostgresQueue                                                                                                                                                                               |
| `type`                        | `'server'                | 'client'`                  | `'server'`                                                                                                                                                                                  |
| `transports`                  | `nodemailer.Transport[]` | —                          | **Required for `server`**. Non-empty.                                                                                                                                                       |
| `josk`                        | `MailTimeJoSkOptions`    | —                          | **Required for `server`**. See below.                                                                                                                                                       |
| `strategy`                    | `'backup'                | 'balancer'`                | `'backup'`                                                                                                                                                                                  |
| `failsToNext`                 | `number`                 | `4`                        | (backup) failures-in-a-row before rotating.                                                                                                                                                 |
| `retries`                     | `number`                 | `60`                       | Re-send attempts after first failure.                                                                                                                                                       |
| `retryDelay`                  | `number` (ms)            | `60000`                    | Wait between attempts.                                                                                                                                                                      |
| `keepHistory`                 | `boolean`                | `false`                    | Keep sent/failed/cancelled rows.                                                                                                                                                            |
| `concatEmails`                | `boolean \| { subject?: string }` | `false`           | Fold same-`to` letters into one. Pass `{ subject: 'X' }` to set the folded-letter subject inline; the string supports the `{{count}}` placeholder and overrides `concatSubject`.                            |
| `concatSubject`               | `string`                 | `'Multiple notifications'` | Subject when folded. Supports `{{count}}` for the folded letter count.                                                                                                                      |
| `concatDelimiter`             | `string`                 | `'<hr>'`                   | Separator between folded bodies.                                                                                                                                                            |
| `concatDelay`                 | `number` (ms)            | `60000`                    | Fold window.                                                                                                                                                                                |
| `revolvingInterval`           | `number` (ms)            | `1536`                     | Queue iteration interval.                                                                                                                                                                   |
| `mode`                        | `'one'                   | 'batch'`                   | `'batch'`                                                                                                                                                                                   |
| `concurrency`                 | `number`                 | `1`                        | Parallel SMTPs per instance. The CAS on `isSending` prevents duplicate delivery.                                                                                                            |
| `sendingTimeout`              | `number` (ms)            | `300000`                   | Window after which a stuck `isSending=true` row becomes eligible again. Must exceed worst-case SMTP roundtrip.                                                                              |
| `template`                    | `string`                 | `'{{{html}}}'`             | Default envelope.                                                                                                                                                                           |
| `prefix`                      | `string`                 | `''`                       | Queue namespace. **Same** on every `client` and `server` for one logical queue; **different** per email class. Inherited by the queue adapter; JoSk scheduler uses `mailTimeQueue<prefix>`. |
| `from`                        | `string                  | (transport) => string`     | —                                                                                                                                                                                           |
| `debug`                       | `boolean`                | `false`                    | Verbose logs.                                                                                                                                                                               |
| `onSent(email, info)`         | `function`               | —                          | Called once the task is fully delivered. `email.mailOptions[i].accepted` lists every address that got through (across all attempts).                                                        |
| `onError(error, email, info)` | `function`               | —                          | Called once the retry budget is exhausted with at least one un-accepted recipient. `email.mailOptions[i].rejected` lists each un-delivered address with its last error.                     |


`josk` is passed to the underlying `[JoSk](https://github.com/veliovgroup/josk)` constructor. Useful keys:


| Key                       | Default           | Notes                                                                              |
| ------------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `adapter`                 | —                 | Either a constructed adapter or `{ type: 'redis'                                   |
| `minRevolvingDelay`       | `512`             | Lower bound of poll window.                                                        |
| `maxRevolvingDelay`       | `2048`            | Upper bound.                                                                       |
| `zombieTime`              | `60000`           | Re-claim if `queue.iterate()` runs longer than this. **Do not drop below 60s.**    |
| `execute`                 | `'batch'`         | JoSk scheduler batching; low impact for MailTime (one interval task per instance). |
| `concurrency`             | `Infinity`        | Cap overlapping JoSk handler runs on **this** process (`1` if ticks pile up).      |
| `autoClear`               | `false`           | Remove orphan tasks from storage.                                                  |
| `lockOwnerId`             | `josk-<uuid>`     | Stable owner id; recommended per worker.                                           |
| `onError(title, details)` | (logs to console) | Wire to your logger.                                                               |


### Methods

- `sendMail(opts)` → `Promise<string>` uuid. Throws on missing `to`/`text`/`html`. Pass any nodemailer message option plus `sendAt` (Date or ms timestamp), `template`, `concatSubject`.
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
| `new RedisQueue({ client, prefix? })`    | `client` from `await redis.createClient().connect()` | `prefix` — inherited from `MailTime` when omitted.                                                           |
| `new MongoQueue({ db, prefix? })`        | `db` from `MongoClient#db()`                         | `prefix` — inherited from `MailTime` when omitted. Indexes auto-created on first `ready()`.                  |
| `new PostgresQueue({ client, prefix? })` | `pg.Pool` (recommended) or `pg.Client`               | `prefix` — inherited from `MailTime` when omitted. `mail_time_queue` table auto-migrated on first `ready()`. |


For custom adapters see [docs/queue-api.md](docs/queue-api.md).

### Module functions

- `mailTimePreset(name, overrides?)` → fresh MailTime constructor config. Deep-clones the named [preset](#settings-presets) and deep-merges your overrides (scalars win, nested `josk` composes). Throws on unknown `name` or non-object `overrides`.
- `presets` — read-only `{ [name]: partialConfig }` map backing `mailTimePreset`.
- `presetNames` — read-only array of preset names.

### Static

- `MailTime.Template` — get/set the default HTML envelope template.

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

# Bun-native test runner (only jest-shaped tests)
bun test ./test/jest
```

`npm test` runs Jest unit tests, then Mocha integration tests, then TypeScript declaration tests. Jest coverage threshold is **85%** across statements, branches, functions, and lines. GitHub Actions runs the matrix against `redis@^4` and `redis@^5`.

## Bun

MailTime ships pure ESM with a generated CJS bundle. Both runtimes (Bun ≥ 1.1.0, Node ≥ 20.9.0) load it directly:

```js
import { MailTime } from 'mail-time'; // works in both
```

Mixed clusters (some Node, some Bun) share one schedule under the same `prefix` — the lease lives in storage, runtime-agnostic.

## Support this project

- Star on [GitHub](https://github.com/veliovgroup/mail-time) and [NPM](https://www.npmjs.com/package/mail-time).
- [Sponsor maintainer on GitHub](https://github.com/sponsors/dr-dimitru).
- [Sponsor veliovgroup on GitHub](https://github.com/sponsors/veliovgroup).
- [PayPal](https://paypal.me/veliovgroup).
- Try [☄️ meteor-files.com](https://meteor-files.com/?ref=github-mail-time-repo-footer).
- Try [▲ ostr.io](https://ostr.io?ref=github-mail-time-repo-footer) for server monitoring, web analytics, web-CRON, and SEO pre-rendering.

