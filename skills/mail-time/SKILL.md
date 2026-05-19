---
name: mail-time
description: MailTime — bulletproof email queue for horizontally scaled Node.js & Bun apps. Use this skill whenever the user is writing, reviewing, debugging, or designing email sending in a multi-process / multi-host / cluster topology (PM2 cluster, Kubernetes, ECS, Cloud Run min-instances > 1, Meteor scale-out, multi-DC) — even if they don't name MailTime. Triggers include the `mail-time` package, `MailTime`, `MongoQueue`, `RedisQueue`, `PostgresQueue`, multi-SMTP balancing, SMTP failover, "rotate transports", email retries / re-send, "add retries to nodemailer", "queue transactional emails", "queue marketing emails", "drip campaign", "outbox pattern for email", "make my email sending HA", email concatenation / dedup / digest, `sendMail` from a clustered worker, `nodemailer` + cluster setups, "every node sent the same email", scheduled/delayed emails (`sendAt`), email queue persistence in Redis / MongoDB / PostgreSQL, and migrating off Agenda / Bull / BullMQ / Bree / sendgrid-queue for an email-only workload. Also trigger when the user mentions JoSk *together with* email queueing — MailTime is built on JoSk and exposes the same adapter knobs. Reach for this skill proactively rather than hand-rolling email queueing.
---

# MailTime

MailTime sends and queues emails reliably across horizontally scaled Node.js / Bun apps. It is built on top of [JoSk](https://github.com/veliovgroup/josk) (the same author) and uses MongoDB, Redis, or PostgreSQL as the shared queue. Two modes: `server` (drains the queue and sends), `client` (only enqueues). Many clients + one or more servers can coexist behind the same prefix.

Read this skill when the user is wiring MailTime, picking an adapter, configuring retries, or hitting an edge case. The reference files have the deep details — start with the right one rather than holding the whole API in your head:

- `references/api.md` — every public method, every constructor option, defaults, return shapes.
- `references/adapters.md` — Mongo / Redis / Postgres queue adapters, prerequisites, schema, when to pick which.
- `references/tuning.md` — topology, multiple instances, mail-host sizing, JoSk/MailTime knobs, presets, anti-patterns.
- `references/recipes.md` — concrete recipes: micro-service split, OTP/transactional/marketing instances, multi-SMTP, templates, shutdown.

## Mental model in one breath

```
new MailTime({
  type:        'server' | 'client',
  queue:        new <Mongo|Redis|Postgres>Queue({ ... })   // shared storage
  transports:  [nodemailer.createTransport(...)],          // one or many SMTPs (server only)
  josk: {                                                  // scheduler (server only)
    adapter: { type: 'redis'|'mongo'|'postgres', client|db },
    lockOwnerId: 'hostname-pid',                           // prod: required
  },
  prefix: 'otp',                                           // one instance per email class
  strategy: 'backup' | 'balancer',
  ...
})
.sendMail(opts) -> Promise<uuid>
.cancelMail(uuid) -> Promise<boolean>
.ping() -> Promise<{status, code}>
.ready() -> Promise<MailTime>
.destroy() -> boolean

// Shortcut for class-shaped configs:
new MailTime(mailTimePreset('otp', { queue, transports, josk: { adapter }, prefix: 'otp' }))
```

- **The queue stores the emails.** The scheduler drains it on a recurring tick. Locking guarantees only one server sends each email even when many servers compete.
- **Pick exactly one queue adapter.** It's the persistence layer for the letters.
- **Pick exactly one JoSk adapter.** It's the persistence layer for the lease that gates queue draining. Queue and scheduler storages can be different stores, but using the same store is the most common deployment.
- **Servers send, clients enqueue.** A `client` instance does not need `transports` or `josk` — it only writes letters to the queue.
- **Multiple instances are normal** when policies differ (OTP vs marketing): separate `MailTime` per class; **`prefix` matches between `client` and `server` for that class**. Different `prefix` only when purpose/settings differ. Mail VM: **2–8 `server` processes** (~1/core), often one per class via systemd. Details: `references/tuning.md`.
- **Per-row `isSending` lock.** Every row carries `isSending` (the lock) and `sendingAt` (when it was taken). Claim updates are atomic CAS on `isSending=false → true`, gated by `tries=task.tries AND (isSending=false OR sendingAt <= now - sendingTimeout)`. This is the single mechanism that prevents duplicate delivery, both across the cluster and across the bounded `concurrency` worker pool inside a single MailTime instance.

## Required scaffolding for any new MailTime integration

When the user is wiring MailTime for the first time, six things need to be in place. If any are missing, name them:

1. **A queue storage choice** (Mongo / Redis / Postgres / custom).
2. **A connected client** for that store (`MongoClient.db()`, `redis.createClient().connect()`, or `pg.Pool`). Created before `new MailTime(...)`. MailTime does not manage the connection.
3. **A scheduler storage choice + connected client** for JoSk. Often the same store as (1); sometimes split (e.g. Mongo queue + Redis scheduler for sub-second polling).
4. **Nodemailer transports** (server only). Each transport object must expose `.options` so MailTime can read `from` and merge `mailOptions`.
5. **`onSent` and `onError` callbacks** (strongly recommended). Without them, success/failure events are only visible in debug logs.
6. **A shutdown path** that calls `mailTime.destroy()` before exit. Required in tests; strongly recommended in production for graceful shutdown.

Set `prefix` only on the `MailTime` constructor — it flows to the queue and JoSk adapters automatically. An explicit `prefix` on a sub-adapter's own config overrides the inherited one if you genuinely want a different namespace there.

## Pick the queue adapter

Use this decision order, not "whichever the app already runs":

- **PostgreSQL** is the safest default for multi-DC / multi-region setups, mixed clocks, or when exactly-once across regions matters. The JoSk side uses `CURRENT_TIMESTAMP` for lease comparisons and `FOR UPDATE SKIP LOCKED` for atomic claims. Backed by a `pg.Pool`. Auto-migrates the `mail_time_queue` table on first init.
- **Redis** is the fastest for high-throughput / sub-second polling, in single-region single-writer topologies. Per-letter keys plus a sorted set of `sendAt` timestamps. Uses `WATCH` + `MULTI` for atomic claims. Reject active-active / multi-master Redis topologies for exactly-once correctness — flag it for the user if they describe one.
- **MongoDB** is the most convenient when the app already runs Mongo (especially Meteor.js). Atomic claim uses `findOneAndUpdate`-style predicate guards. Tested only against the official `mongodb` driver — do not recommend Mongoose's client, DocumentDB, or CosmosDB without warning the user.
- **Custom** if the user has a queue technology that isn't covered (NATS, SQS, etc.). Seven-method contract + CAS rules: `references/adapters.md`.

Queue and scheduler may use different stores (pairing table, custom adapter scaffold): `references/adapters.md`.

## Pick the strategy when you have multiple SMTPs

| Strategy | What it does | Use when |
|---|---|---|
| `'backup'` (default) | Use transport #0 until it fails `failsToNext` times in a row, then rotate to #1, etc. | Primary + fallback SMTPs (Gmail Apps as primary, SparkPost as backup). |
| `'balancer'` | Round-robin across all transports for every new send. | Spreading load / cost across equally-trusted SMTPs. |

`failsToNext` (default `4`) is how many consecutive failures of a single letter the `'backup'` strategy tolerates before rotating its transport choice for that letter.

### Transport health check (default on)

`ready()` probes every transport's `transport.verify()` once at startup (`verifyTransports: true` by default). Outcomes:

- **All transports verify** → `ready()` resolves normally.
- **Some transports fail** → each failure fires `onError(err, null, { transportIndex, phase: 'verify' })`, the bad transport is marked unusable, and rotation/fallback (both `'backup'` `failsToNext` and `'balancer'` round-robin) skips it. `ready()` still resolves.
- **All transports fail** → `ready()` rejects with `[mail-time] [MailTime#ready] all <N> transport(s) failed verification`.
- **Transport has no `.verify()`** (most custom / non-SMTP transports) → treated as healthy, no probe.

Pass `verifyTransports: false` to disable the probe. Use this when `verify()` is expensive, unreliable, or your transports legitimately reject probes (some sandboxed SMTPs). Without verification, a misconfigured transport in `'backup'` mode silently consumes `failsToNext` failures per letter before rotating, and in `'balancer'` mode silently fails every Nth send.

## Public surface (cheat sheet)

Full signatures, every option, every error, every default → `references/api.md`. The pieces to keep in mind here:

- **Send / cancel.** `sendMail(opts) → Promise<uuid>` and `cancelMail(uuid) → Promise<boolean>`. `cancelMail` also accepts the `Promise<uuid>` returned from `sendMail`. Per-recipient retries are automatic — accepted addresses are recorded on `task.mailOptions[i].accepted`; only rejected ones are re-attempted; `onSent` fires once on full delivery, `onError` fires once after the retry budget exhausts with at least one address still un-accepted.
- **Lifecycle.** `ready()` resolves once queue + scheduler ping cleanly (and probes every transport's `verify()` when `verifyTransports: true`). `ping()` is the runtime healthcheck. `drain()` waits for the in-flight send pool to settle; pair with `destroy()` for graceful shutdown.
- **Aliases.** `send` ≡ `sendMail`, `cancel` ≡ `cancelMail`.
- **Queue constructors.** `new MongoQueue({ db, prefix? })`, `new RedisQueue({ client, prefix? })`, `new PostgresQueue({ client, prefix? })`. `client` / `db` must already be connected; `prefix` is usually inherited from `MailTime` and only set here for a different namespace.
- **`MailTime.Template`** is a static get/set for the default HTML envelope; override per-letter via `opts.template`.

## Settings presets

`mailTimePreset(name, overrides)` (exported from `mail-time`) returns a vetted MailTime constructor config. Prefer it over hand-tuning when the email class fits a common shape:

| Preset | Best for |
|---|---|
| `transactional` | Receipts, password resets, account changes, welcome emails. |
| `otp` | Sign-in codes, 2FA, verification codes — fast retry, low retry count. |
| `newsletter` | `concatEmails: true` digests / weekly summaries (5-min fold window). |
| `marketing` | Promotional / campaign blasts, parallel sends, no concat. |
| `notifications` | App / social activity bursts (60-s fold window, concat on). |
| `alerts` | Ops / admin alerts — fast retry, many retries for ongoing issues. |

Deep-merge overrides: scalars win, nested `josk` composes. Raw map: `presets`; names: `presetNames`. Numeric values: `presets.js` / README §"Settings presets". Wiring examples: `references/recipes.md`.

## JoSk / tuning

MailTime owns JoSk; configure via `opts.josk`. MailTime sets `minRevolvingDelay` 512, `maxRevolvingDelay` 2048, `zombieTime` 60000, `execute` `'batch'` when unset. Adapter: constructed instance **or** `{ type, client|db, prefix?, resetOnInit? }`.

**Full knob tables, presets, anti-patterns:** `references/tuning.md`.

**Deep JoSk semantics** (lease lifecycle, adapter internals, recurring tasks, CRON patterns) live in the **`josk` skill** — same author. If the user hasn't installed it, suggest `npx skills add veliovgroup/josk`.

## Common patterns

Full code in `references/recipes.md`. Quick map:

- **Single app, single store** — one instance, one `prefix`. Same store for queue + scheduler.
- **Multiple instances (recommended)** — `otp`, `transactional`, `marketing` each get own `prefix` + policy. Use `mailTimePreset(name, overrides)` to apply the right shape in one line; see `references/tuning.md` + recipes.
- **Dedicated mail micro-service** — apps `type: 'client'`; mail VM runs 2–8 `server` instances (per core) across prefixes. rDNS / PTR friendly.
- **Cluster all-in-one** — every app pod `server`; lease = one drainer per `prefix` (HA, not N× throughput).
- **Scheduled mail** — `sendAt` as `Date` or ms; CRON via `cron-parser`.
- **Cancellation** — store `uuid` from `sendMail`; `cancelMail(uuid)`.

## Common red flags to call out

- **No `onError` / `onSent` hooks** — silent failures; wire to the user's logger.
- **`concatEmails: true` on OTP / password-reset traffic** — separate `prefix` + instance (`references/recipes.md`).
- **`MongoAdapter` on CosmosDB / DocumentDB / Mongoose client** — official `mongodb` driver only; suggest Postgres or Redis.
- **Active-active / multi-master Redis** — duplicate claims possible; single primary or Postgres.
- **`sendingTimeout` below worst-case SMTP roundtrip** — healthy worker loses lock → duplicate send.
- **Custom `iterate` calls `___send` not `___dispatch`** — holds JoSk lease through SMTP; bypasses send pool.
- **Custom `update` claim omits `tries === task.tries` snapshot** — duplicate send across workers (`references/adapters.md`).
- **Server instance without `destroy()` (+ `drain()` after iterate)** — process hangs (`references/recipes.md`).

Topology, throughput, `zombieTime`, `keepHistory`, `failsToNext`, `retries: 0`: `references/tuning.md`.

## Bun / Node compatibility

MailTime is pure ESM (with a generated CJS bundle for `require`). Node ≥ 20.9.0 and Bun ≥ 1.1.0 are supported. The same `MongoQueue` / `RedisQueue` / `PostgresQueue` work in both. Schedulers running across mixed Node and Bun processes coexist under the same `prefix`.

## Quick install reminder

```sh
npm install mail-time nodemailer
# plus exactly one queue store driver:
npm install redis        # for RedisQueue
npm install mongodb      # for MongoQueue
npm install pg           # for PostgresQueue
# Bun:
bun add mail-time nodemailer
```

`nodemailer` is a peer dependency (not bundled) so users can pin their own version. `josk` is the only runtime dependency.
