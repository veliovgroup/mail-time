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
| `concurrency: N` (MailTime) | N parallel SMTPs per instance. CAS blocks concurrent claims. |
| `mode: 'one'` (MailTime) | One claim per tick. Fairer cluster-wide; lower per-tick throughput. |
| `revolvingInterval` ↓, `josk.min/maxRevolvingDelay` ↓ | Faster pickup, more storage I/O |
| Dedicated mail workers | SMTP isolated from app |
| `josk.concurrency: 1` | No overlapping `iterate` on one process |

## MailTime / JoSk defaults

| Knob | Default | Tune |
|---|---|---|
| `mode` | `'batch'` | `'one'` claims a single row per tick (fairness). |
| `concurrency` | `1` | Parallel SMTPs per instance. Increase for throughput; cap by SMTP rate limits. |
| `sendingTimeout` | 300000 (5 min) | Window before a stuck `isSending=true` row becomes recoverable. Must exceed worst-case SMTP; warns below 120000. |
| `renewClaim` | `sendingTimeout / 3` | Re-stamps `sendingAt` while the send is in flight so a slow-but-healthy send keeps its lock. `false` = v4 behaviour. |
| `maxRenewals` | 10 | Renewal-attempt budget; recovery begins `sendingTimeout` after last successful stamp. Slow renewal writes can extend elapsed time. |
| `shouldFailOver` | — | Veto transport rotation for a failure that may already have been delivered. |
| `strictPayload` | false | Allowlist queued fields + force `disableFileAccess`/`disableUrlAccess`. |
| `revolvingInterval` | 1536 | Latency vs I/O |
| `josk.min/maxRevolvingDelay` | 512 / 2048 | Overrides JoSk 128/768 |
| `josk.zombieTime` | 60000 | **≥60s**. `___iterate` releases the lease right after the scan, so only a stalled storage scan can blow this. |
| `josk.lockLeaseTime` | 30000 | JoSk 6.3 scheduler lease TTL; floored at `2 * maxRevolvingDelay + 1000`. Raise for slow storage claim batches; separate from `zombieTime`. |
| `josk.execute` | `'batch'` | Usually omit; one JoSk uid per instance |
| `josk.concurrency` | `Infinity` | `1` if scheduler ticks overlap |
| `josk.lockOwnerId` | random | **Prod:** `hostname-pid` or pod name |
| `retries` / `retryDelay` | 59 / 60s | 60 total attempts by default; tune per class. |
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

The atomic CAS on `isSending` prevents concurrent claims across cluster workers and `concurrency > 1`. SMTP acceptance followed by a lost completion write remains an unavoidable at-least-once edge.

## Presets

Built-in: `mailTimePreset(name, overrides)` (exported from `mail-time`). Returns a fresh, mutable MailTime config; deep-merges overrides onto a frozen preset. Names: `transactional`, `otp`, `newsletter`, `marketing`, `notifications`, `alerts`. Source/values: `presets.js`.

| Preset | Best for |
|---|---|
| `transactional` | Receipts, password resets, account mail |
| `otp` | Sign-in codes, 2FA — fast retry, parallel SMTP |
| `newsletter` | Concat digests / weekly summaries |
| `marketing` | Campaign blasts, parallel sends, no concat |
| `notifications` | Activity bursts with concat fold |
| `alerts` | Ops alerts — fast retry, many attempts |

Numeric knobs per preset: `presets.js` or README §"Settings presets".

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
- `sendingTimeout` < worst-case SMTP roundtrip — a live still-sending worker can lose its lock to a recovery worker, causing duplicate delivery. v5's `renewClaim` covers the healthy-but-slow case; it does not excuse a `sendingTimeout` shorter than your storage round-trip.
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
