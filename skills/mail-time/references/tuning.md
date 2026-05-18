# MailTime tuning (agent reference)

One JoSk `setInterval` per `prefix` (`mailTimeQueue<prefix>` → `queue.iterate()`). Cluster-wide: **one lease winner per tick per prefix** — extra `server` pods on same `prefix` ≠ N× throughput, but **do** buy failover/HA (warm standby takes the lease the next tick if the winner dies).

## Multiple instances — default pattern

- **One `MailTime` per email class** when policies differ: own options; **distinct `prefix` only per class** (OTP vs marketing).
- **`prefix` same** on every `client` + `server` for that class (shared queue).
- **Never** reuse `prefix` across instances with different mail policy.
- Apps: `type: 'client'`. Mail VM: `type: 'server'` (systemd: `mailtime@otp`, etc.).

| Class | `concatEmails` | `retryDelay` | `revolvingInterval` | josk jitter |
|---|---|---|---|---|
| OTP / alerts | `false` | 2–5s | `1024` | 256 / 1024 |
| Transactional | `false` | 5–15s | default | default |
| Marketing | `true`, long `concatDelay` | 60s | default | default |

## Mail host: 2–8 servers on one machine

- **2–8 `server` instances** (~**1 per CPU core**) → parallel drains **across prefixes**, not duplicate drains of same `prefix`.
- One hot queue → **shard prefixes** (`marketing-0`, …), not many instances same `prefix`.
- Duplicate same-`prefix` `server` (different `lockOwnerId`) only buys **failover/HA** — warm standby takes the lease the next tick when the winner dies; never adds throughput.

## Throughput levers

| Lever | Effect |
|---|---|
| More `prefix`es / instances | More parallel drain loops |
| `concurrency: N` (MailTime) | N parallel SMTPs per instance. Safe — CAS on `isSending` blocks dupes. |
| `mode: 'one'` (MailTime) | One claim per tick. Fairer cluster-wide; lower per-tick throughput. |
| `revolvingInterval` ↓, `josk.min/maxRevolvingDelay` ↓ | Faster pickup, more storage I/O |
| Dedicated mail workers | SMTP isolated from app |
| `josk.concurrency: 1` | No overlapping `iterate` on one process |

## MailTime / JoSk defaults

| Knob | Default | Tune |
|---|---|---|
| `mode` | `'batch'` | `'one'` claims a single row per tick (fairness). |
| `concurrency` | `1` | Parallel SMTPs per instance. Increase for throughput; cap by SMTP rate limits. |
| `sendingTimeout` | 300000 (5 min) | Window before a stuck `isSending=true` row becomes recoverable. Must exceed worst-case SMTP. |
| `revolvingInterval` | 1536 | Latency vs I/O |
| `josk.min/maxRevolvingDelay` | 512 / 2048 | Overrides JoSk 128/768 |
| `josk.zombieTime` | 60000 | **≥60s**. `___iterate` releases the lease right after the scan, so only a stalled storage scan can blow this. |
| `josk.execute` | `'batch'` | Usually omit; one JoSk uid per instance |
| `josk.concurrency` | `Infinity` | `1` if scheduler ticks overlap |
| `josk.lockOwnerId` | random | **Prod:** `hostname-pid` or pod name |
| `retries` / `retryDelay` | 60 / 60s | Per class |
| `concatEmails` | `false` | `true` marketing only |

## Per-row lifecycle (`isSending` lock)

1. JoSk tick fires → `___iterate` calls `queue.iterate({ limit, sendingTimeout })`.
2. Adapter streams candidate rows (eligibility predicate includes `isSending=false OR sendingAt<=now-sendingTimeout`).
3. For each row: `await mailTime.___dispatch(row)` waits for a free pool slot, then atomically claims (`isSending=true, sendingAt=now, tries=+1`), then starts SMTP detached.
4. Scan continues to the next row → JoSk lease is released once scanning ends.
5. SMTP completes in the background:
   - **Success** → row removed (or `isSent=true, isSending=false, sendingAt=0` with `keepHistory`).
   - **Will-retry** → `isSending=false, sendingAt=0, sendAt=now+retryDelay`.
   - **Final failure** → `isFailed=true, isSending=false, sendingAt=0` (or row removed).
6. If a worker dies between (3) and (5), the row stays `isSending=true` until `sendingAt+sendingTimeout` is in the past, then becomes eligible again on the next iterate.

The atomic CAS on `isSending` is the single mechanism that prevents duplicate delivery — both across the cluster and across `concurrency > 1` inside one instance.

## Presets

Built-in: `mailTimePreset(name, overrides)` (exported from `mail-time`). Returns a fresh, mutable MailTime config; deep-merges overrides onto a frozen preset. Names: `transactional`, `otp`, `newsletter`, `marketing`, `notifications`, `alerts`. Source/values: `presets.js`.

| Preset | Shape highlights |
|---|---|
| `transactional` | `retries: 30`, `retryDelay: 10s`, `concatEmails: false`, `concurrency: 1`, `josk.zombieTime: 120s` |
| `otp` | `retries: 5`, `retryDelay: 2s`, `revolvingInterval: 1024` + jitter `256/1024`, `concurrency: 4`, `sendingTimeout: 60s` |
| `newsletter` | `concatEmails: true` (5-min fold), `retries: 5`, `retryDelay: 60s`, `concurrency: 2`, `sendingTimeout: 10min`, `josk.zombieTime: 5min` |
| `marketing` | `retries: 10`, `retryDelay: 30s`, `concatEmails: false`, `concurrency: 5`, `josk.zombieTime: 3min` |
| `notifications` | `concatEmails: true` (60-s fold), `retries: 8`, `retryDelay: 30s`, `concurrency: 3`, `josk.zombieTime: 3min` |
| `alerts` | `retries: 20`, `retryDelay: 5s`, `revolvingInterval: 1024` + jitter `256/1024`, `concurrency: 2`, `sendingTimeout: 60s` |

Every preset pins `mode: 'batch'` explicitly. `'one'` only earns its keep when multiple `server` pods compete on the same `prefix` (rare — same-`prefix` duplicates exist for failover/HA, not throughput) — none of the preset use-cases benefit from it. Override per-call with `mailTimePreset(name, { mode: 'one' })` if a downstream forces it.

Non-preset cases:

| Case | Store | Notes |
|---|---|---|
| Multi-DC | Postgres+Postgres | `lockOwnerId` per worker; primary only |
| Rate-limited SMTP | any | Few servers; `josk.concurrency: 1` |
| Tests | any | `retries: 0`, `destroy()`; `resetOnInit` dev only |

## Anti-patterns

- Many `server` pods, one `prefix` for throughput and concurrency.
- `zombieTime` < worst-case storage scan time.
- `sendingTimeout` < worst-case SMTP roundtrip — a live still-sending worker can lose its lock to a recovery worker, causing duplicate delivery.
- `resetOnInit` / `autoClear` in prod without intent.
- Replica reads for queue or scheduler.
- `concatEmails: true` on OTP / password reset.
- Custom adapter calling `___send` from `iterate` instead of `___dispatch` — defeats the pool and holds the JoSk lease during SMTP.

## Production `josk` (any adapter)

```js
josk: {
  adapter: { type: 'redis', client },
  lockOwnerId: `${process.env.K8S_POD_NAME || process.env.HOSTNAME}-${process.pid}`,
  onError: (title, d) => logger.error({ scheduler: title, ...d }),
  concurrency: 1,      // if ticks overlap long iterate
  zombieTime: 120_000, // if backlog × slow SMTP > 60s
},
```
