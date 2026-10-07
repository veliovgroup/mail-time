# MailTime tuning (agent reference)

One JoSk `setInterval` per `prefix` (`mailTimeQueue<prefix>` → `queue.iterate()`). Cluster-wide: **one lease winner per tick per prefix**. Extra same-prefix servers buy failover, not N× throughput. JoSk 6.4+ keeps an unfinished scan claim across restarts; after an unclean death, the next scan can wait until `josk.zombieTime`. Graceful `destroy({ drain: true })` uses JoSk `shutdown()`.

## Instances and prefixes

- One `MailTime` per email class with its own `prefix`; same `prefix` on every `client` and `server` of that class; never reuse a `prefix` with different policy. Code: `recipes.md` §Multiple instances.
- Dedicated mail host: 2–8 `server` instances, one per prefix (≈1 per core). Same-prefix duplicates buy failover only; shard a hot queue by prefix (`marketing-0`, …). Code: `recipes.md` §Mail host.

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
| `renewClaim` | `sendingTimeout / 3` (min 1000 ms) | Re-stamps `sendingAt` while the send is in flight so a slow-but-healthy send keeps its lock. `false` = v4 behaviour. |
| `maxRenewals` | 10 | Renewal-attempt budget; recovery begins `sendingTimeout` after last successful stamp. Slow renewal writes can extend elapsed time. |
| `shouldFailOver` | — | Veto transport rotation for a failure that may already have been delivered. |
| `strictPayload` | false | Allowlist queued fields + force `disableFileAccess`/`disableUrlAccess`. |
| `revolvingInterval` | 1536 | Latency vs I/O |
| `josk.min/maxRevolvingDelay` | 512 / 2048 | Overrides JoSk 128/768 |
| `josk.zombieTime` | 60000 | **≥60s**. Claim recovery after an unfinished scan or unclean restart; SMTP rows use `sendingTimeout`. |
| `josk.lockLeaseTime` | 30000 | Scheduler lease TTL; floored at `2 * maxRevolvingDelay + 1000`. Separate from `zombieTime`. |
| `josk.execute` | `'batch'` | Usually omit; one JoSk uid per instance |
| `josk.concurrency` | `Infinity` | `1` if scheduler ticks overlap |
| `josk.lockOwnerId` | random | **Prod:** `hostname-pid` or pod name |
| `retries` / `retryDelay` | 59 / 60s | 60 total attempts by default; tune per class. |
| `concatEmails` | `false` | `true` marketing only |

`destroy({ drain: true, schedulerTimeout: 30000 })` waits for JoSk's scan, then SMTP. Queued sends that have not started are dropped at once (rows stay unclaimed), so in-flight SMTP does not count against the timeout. Default handler timeout: 10s; a timeout or JoSk shutdown error returns `false` (never rejects). It does not bound JoSk's own storage scan or SMTP. [JoSk 6.4 recovery details](https://github.com/veliovgroup/mail-time/blob/master/docs/tuning.md#josk-64-restarts-and-shutdown).

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
- Redis / KeyDB / Valkey Cluster without `useHashTags: true` on both `RedisQueue` and `josk.adapter`.
- KeyDB active-replication / Redis active-active. Single writable primary, or Postgres.
- `concatEmails: true` on OTP / password reset.
- Custom adapter calling `___send` from `iterate` instead of `___dispatch` — defeats the pool and holds the JoSk lease during SMTP.

## Production `josk` (any adapter)

```js
josk: {
  adapter: { type: 'redis', client },
  lockOwnerId: `${process.env.K8S_POD_NAME || process.env.HOSTNAME}-${process.pid}`,
  onError: (title, d) => logger.error({ scheduler: title, ...d }),
  concurrency: 1,      // if ticks overlap long iterate
  zombieTime: 120_000, // if a queue scan can exceed 60s
},
```
