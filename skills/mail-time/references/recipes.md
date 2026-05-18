# MailTime patterns & recipes

Working code for the situations users hit most often. Each shows the canonical solution, the failure mode it avoids, and the tuning knobs worth knowing.

## Single app, single store (Redis)

The most common shape. One MailTime instance, one Redis client, runs in every app process.

```js
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';
import nodemailer from 'nodemailer';

const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();

const transports = [
  nodemailer.createTransport({
    host: 'smtp.example.com',
    auth: { user: 'no-reply', pass: process.env.SMTP_PASS },
  }),
];
transports[0].options.from = 'no-reply@example.com';

const mailQueue = new MailTime({
  type: 'server',
  queue: new RedisQueue({ client: redisClient }),
  josk: {
    adapter: { type: 'redis', client: redisClient },
    lockOwnerId: process.env.HOSTNAME || 'mail-worker',
  },
  transports,
  template: MailTime.Template,
  from: (transport) => `"Acme" <${transport.options.from}>`,
  onSent(email, info) {
    logger.info('mail.sent', { uuid: email.uuid, to: email.mailOptions[0].to, info });
  },
  onError(error, email, info) {
    logger.error('mail.failed', { uuid: email.uuid, to: email.mailOptions[0].to, error, info });
  },
});

await mailQueue.ready();

process.on('SIGTERM', () => {
  mailQueue.destroy();
});

export { mailQueue };
```

**Why this shape:** every process is also a sender. JoSk's lease guarantees one sender per email despite N competing processes.

## Dedicated mail micro-service (client + server split)

App servers only enqueue. A dedicated machine drains and sends. Common when SMTPs require rDNS / PTR / fixed IP.

```js
// app-server.js — runs on every app process
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';

export const mailQueue = new MailTime({
  type: 'client',
  queue: new RedisQueue({
    client: await createClient({ url: process.env.REDIS_URL }).connect(),
  }),
});
// no transports, no josk — clients only enqueue.

// later in your code:
await mailQueue.sendMail({
  to: 'user@example.com',
  subject: 'Welcome',
  html: '<h1>Hi</h1>',
});
```

```js
// mail-microservice.js — runs once, on a dedicated machine
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';
import nodemailer from 'nodemailer';

const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();

const mailQueue = new MailTime({
  type: 'server',
  queue: new RedisQueue({ client: redisClient }),
  josk: {
    adapter: { type: 'redis', client: redisClient },
    lockOwnerId: 'mail-microservice',
  },
  transports: [
    nodemailer.createTransport({ host: 'smtp.example.com', /* ... */ }),
  ],
});
await mailQueue.ready();
```

**Why this shape:** app servers have zero SMTP credentials; the dedicated machine has fixed networking and credentials.

## Cluster — every node is also a sender

Same as "Single app, single store". Set a distinct `lockOwnerId` per worker so the storage lease is observable:

```js
const lockOwnerId = `${process.env.K8S_POD_NAME || os.hostname()}-${process.pid}`;
const mailQueue = new MailTime({
  /* ... */
  josk: { adapter: { /* ... */ }, lockOwnerId },
});
```

## Multiple instances — OTP, transactional, marketing

**Recommended:** one `MailTime` per email class. Distinct `prefix` on `MailTime` only (queue inherits). One Redis client OK. Apply tuning via `mailTimePreset(name, overrides)` instead of hand-coding knobs — see `tuning.md` §Presets.

```js
import { MailTime, RedisQueue, mailTimePreset } from 'mail-time';

const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();
const adapter = { type: 'redis', client: redisClient };
const lockOwnerId = `${process.env.HOSTNAME}-${process.pid}`;
const queue = () => new RedisQueue({ client: redisClient });

export const otpMail = new MailTime(mailTimePreset('otp', {
  type: 'server', prefix: 'otp',
  queue: queue(), transports: [otpTransport],
  josk: { adapter, lockOwnerId },
}));

export const transactionalMail = new MailTime(mailTimePreset('transactional', {
  type: 'server', prefix: 'transactional',
  queue: queue(), transports,
  josk: { adapter, lockOwnerId },
}));

export const marketingMail = new MailTime(mailTimePreset('newsletter', {
  type: 'server', prefix: 'marketing',
  queue: queue(), transports,
  josk: { adapter, lockOwnerId },
}));

await Promise.all([otpMail, transactionalMail, marketingMail].map((m) => m.ready()));
```

**Pitfall:** use the **same `prefix`** on app `client` and mail `server` for a class; use a **different `prefix`** only for another class (OTP vs marketing). Never `concatEmails: true` on OTP — the `otp` preset enforces this.

## Mail host — 2–8 servers on one machine

On a dedicated mail VM, run **2–8 `server` instances** (~1 per CPU core) for **parallel drains across prefixes** (e.g. otp + transactional + marketing). Multiple instances on the **same** `prefix` are bound by one cluster-wide lease — useful for **failover/HA** (a warm standby with a different `lockOwnerId` takes over the next tick if the primary dies), not for throughput.

```js
import { otpMail, transactionalMail, marketingMail } from './mail-instances.js';

const workers = [otpMail, transactionalMail, marketingMail];
await Promise.all(workers.map((m) => m.ready()));
process.on('SIGTERM', () => workers.forEach((m) => m.destroy()));
```

High volume on one logical queue → shard prefixes (`marketing-0`, `marketing-1`). See `tuning.md`.

## Mongo + Redis (split queue / scheduler)

Mongo for durable letter storage, Redis for tight scheduler polling.

```js
import { MailTime, MongoQueue } from 'mail-time';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';

const db = (await MongoClient.connect(process.env.MONGO_URL)).db('mailtime');
const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();

const mailQueue = new MailTime({
  type: 'server',
  queue: new MongoQueue({ db }),
  josk: {
    adapter: { type: 'redis', client: redisClient },
    minRevolvingDelay: 256,
    maxRevolvingDelay: 1024,
  },
  transports,
});
```

**Why:** Mongo gives you queryable durable letter storage (good for audits and `keepHistory: true`); Redis gives the scheduler sub-second polling.

## Multi-SMTP rotation

```js
import nodemailer from 'nodemailer';

const transports = [
  nodemailer.createTransport({ host: 'smtp.gmail.com', /* ... */ }),
  nodemailer.createTransport({ host: 'smtp.sparkpostmail.com', /* ... */ }),
  nodemailer.createTransport({ host: 'smtp.example.com', /* ... */ }),
];
// EVERY transport must expose .options.from for MailTime's `from(transport)` callback to work.
for (const t of transports) {
  t.options.from = t.options.from || 'no-reply@example.com';
}

// Backup: try transport 0; rotate on failure.
const mailQueue = new MailTime({
  /* ... */
  transports,
  strategy: 'backup',
  failsToNext: 3,
});

// OR — Balancer: round-robin every send for cost spreading.
const mailQueue2 = new MailTime({
  /* ... */
  transports,
  strategy: 'balancer',
});
```

## Templating

```js
const layouts = {
  envelope: `
    <html><body>
      <h1>{{subject}}</h1>
      {{{html}}}
      <footer>Sent to @{{username}} ({{to}})</footer>
    </body></html>`,
  otp: {
    text: 'Hello @{{username}}! Your code: {{code}}',
    html: '<p>Hello <b>@{{username}}</b></p><pre>{{code}}</pre>',
  },
};

const mailQueue = new MailTime({
  /* ... */
  template: layouts.envelope,
});

await mailQueue.sendMail({
  to: 'user@example.com',
  subject: 'Your sign-in code',
  username: 'mike',
  code: 'A1B2-C3D4',
  text: layouts.otp.text,
  html: layouts.otp.html,
});
```

Two placeholder forms:
- `{{key}}` — string interpolation, **strips HTML** from the value (safe for `text`).
- `{{{key}}}` — raw HTML interpolation (use for `{{{html}}}` in the envelope).

## Scheduled / delayed emails

```js
const tomorrowAt9am = new Date();
tomorrowAt9am.setDate(tomorrowAt9am.getDate() + 1);
tomorrowAt9am.setHours(9, 0, 0, 0);

const uuid = await mailQueue.sendMail({
  to: 'user@example.com',
  subject: 'Daily digest',
  html: '<h1>Today</h1>',
  sendAt: tomorrowAt9am,
});
```

CRON-style via `cron-parser`:

```js
import { CronExpressionParser } from 'cron-parser';

const scheduleDigest = async () => {
  const next = CronExpressionParser.parse('0 9 * * MON-FRI').next().toDate();
  return mailQueue.sendMail({
    to: 'user@example.com',
    subject: 'Daily digest',
    html: '<h1>Today</h1>',
    sendAt: next,
  });
};

await scheduleDigest();
// Re-schedule the next one from your `onSent` hook to keep it recurring.
```

## Cancellation

```js
const uuid = await mailQueue.sendMail({
  to: 'user@example.com',
  subject: 'Welcome',
  html: '<h1>Hi</h1>',
  sendAt: Date.now() + 60 * 60_000, // 1 hour from now
});

// Later, before sendAt:
const ok = await mailQueue.cancelMail(uuid);
// ok === true → cancelled
// ok === false → already sent / already cancelled / unknown uuid
```

`cancelMail` accepts a `Promise<string>` too — no need to await `sendMail` first:

```js
const pending = mailQueue.sendMail({ /* ... */ });
// elsewhere, conditionally:
await mailQueue.cancelMail(pending);
```

## Graceful shutdown

```js
const shutdown = async () => {
  // 1. Stop the scheduler so no new ticks fire.
  mailQueue.destroy();
  // 2. Let any in-flight SMTP sends finish (bounded by `concurrency`).
  await mailQueue.drain();
  // 3. Close downstream connections AFTER drain.
  await redisClient?.quit?.();
  await pgPool?.end?.();
  await mongoClient?.close?.();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
```

In tests, **always** call `destroy()` (and `drain()` when the test exercised the iterate path) and close the underlying client; otherwise the suite hangs on the open scheduler timer / connection pool.

## Scaling sends inside a single instance

```js
const mailQueue = new MailTime({
  queue: new RedisQueue({ client }),
  transports: [transport],
  // Drain every due row per tick (default), and run up to 8 SMTPs in parallel.
  mode: 'batch',
  concurrency: 8,
  // 2 minutes — comfortably above worst-case SMTP roundtrip for this provider.
  sendingTimeout: 120_000,
  josk: {
    adapter: { type: 'redis', client },
    lockOwnerId: `${process.env.HOSTNAME}-${process.pid}`,
  },
});
```

How this scales without duplicate sends:

- Each iterate tick claims rows one-at-a-time via the atomic CAS on `isSending`.
- Claimed rows are handed to the internal pool; up to `concurrency` SMTPs run in parallel.
- If another node (or another tick on this node) tries to claim a row that's already `isSending=true`, the CAS rejects it. No double-send.
- If a worker dies mid-send, the row stays `isSending=true` for at most `sendingTimeout` ms, then becomes eligible again. The new claimer's CAS still gates on `tries`, so a slow-but-alive worker that finishes after recovery has already started will lose its release update (its `tries` snapshot no longer matches), and the row continues on the recovery path.

Use `mode: 'one'` instead of `'batch'` when you want each tick to claim a single row — useful when one cluster node tends to win the JoSk lease repeatedly and you want fairer per-tick distribution across nodes:

```js
const mailQueue = new MailTime({
  /* ... */
  mode: 'one',
  concurrency: 1,
});
```

## Healthcheck endpoint

```js
app.get('/health/mail', async (_req, res) => {
  const r = await mailQueue.ping();
  res.status(r.code).json(r);
});
```

## Email concatenation pitfalls

`concatEmails: true` folds same-`to` letters that arrive inside `concatDelay` ms. It is **wrong** for transactional emails:

- OTPs / sign-in codes — a fresh request must not be folded under the previous code.
- Password resets — same reason.
- Receipts — each transaction is distinct.

Use the **multiple-instance pattern** above: OTP/transactional `concatEmails: false`, marketing `concatEmails: true`.

## Migrating off Agenda / Bull / BullMQ for email

Map the concepts:

- **Job** → MailTime task (the `uuid` returned by `sendMail`).
- **Recurring job** → use `sendAt` per send. MailTime is not a CRON scheduler — JoSk is. Use JoSk directly for arbitrary recurring work; use MailTime for the email-shaped subset.
- **Worker process** → MailTime `'server'` instance.
- **Dashboard** → MailTime has none. Persist `onSent` / `onError` events to your existing log infra.

Migrate gradually: spin up MailTime alongside, route new emails through it, drain the old queue, decommission the old worker.
