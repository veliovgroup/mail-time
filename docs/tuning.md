# MailTime tuning

Reach for a [preset](../README.md#settings-presets) first; tune individual knobs only when the preset doesn't cover your case. The presets ship with [`mail-time`](../README.md) and apply a vetted shape in one line — read this file when a preset isn't enough.

## How scheduling relates to throughput

MailTime registers **one** JoSk interval per `prefix` (`mailTimeQueue<prefix>` → `queue.iterate()`). Across the cluster, **one `server` wins that lease per tick** — extra app replicas mostly buy **failover**, not N× send rate for the same `prefix`.

Inside one server, MailTime drives sends through a bounded **in-process send pool** (`concurrency`). When a tick fires:

1. `queue.iterate({ limit, sendingTimeout })` streams candidate rows.
2. Each row is handed to `mailTime.___dispatch(row)`, which waits for a free pool slot, atomically claims the row by flipping `isSending=false → true` (with `sendingAt=now`), and starts the full send lifecycle in the background.
3. The scan moves to the next due row as soon as the previous claim has started — the JoSk lease is released as soon as scanning ends, so other ticks (on this or any cluster node) can pick up rows still `isSending=false`.
4. The SMTP roundtrip runs detached. On success the row is removed (or marked `isSent: true` with `keepHistory`); on failure `isSending` flips back to `false` and `sendAt` is bumped for the next retry.

`isSending` is the **per-row lock**. The storage-level atomic-claim CAS makes it impossible for two workers — same instance or across the cluster — to flip the same row from `false` to `true` at the same `tries` value. A worker that died mid-SMTP leaves the row `isSending=true`; once `sendingAt + sendingTimeout` is in the past, the iterate predicate makes that row eligible again and a recovery worker can re-claim it.

## Throughput levers

- More **distinct `prefix`es** (OTP vs marketing, or shards) → more parallel drain loops.
- **Dedicated mail workers** (`type: 'client'` on apps, `type: 'server'` on 1–3 mail hosts) → cleaner SMTP and tuning.
- **`concurrency: N`** (MailTime option) → up to N parallel SMTPs per server instance. The CAS on `isSending` is what makes this safe — two parallel sends never deliver the same row.
- **`mode: 'one' \| 'batch'`** (MailTime option) → `'batch'` (default) claims every due row per tick; `'one'` claims a single row per tick (fairer across cluster nodes when one node has dominant scheduling luck).
- **`revolvingInterval`** + **`josk.minRevolvingDelay` / `maxRevolvingDelay`** → how often due mail is picked up (effective delay ≈ interval + jitter + storage RTT).
- **Few fat mail hosts** with several instances → better than dozens of app pods all running `server`.

## Scenario guide

Reach for a [preset](../README.md#settings-presets) first; tune only what the preset doesn't cover.

| Situation                            | What to change                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| OTP / alerts                         | `mailTimePreset('otp')` or `mailTimePreset('alerts')`                                                                      |
| Receipts / password resets / welcome | `mailTimePreset('transactional')`                                                                                          |
| Newsletters / activity digests       | `mailTimePreset('newsletter')` or `mailTimePreset('notifications')`                                                        |
| Marketing campaigns                  | `mailTimePreset('marketing')`                                                                                              |
| Multi-DC or clock skew               | Postgres queue + Postgres scheduler; stable `lockOwnerId` per worker                                                       |
| Mongo letters + fast polls           | Mongo `queue`, Redis `josk.adapter` (see [Storage layouts](../README.md#storage-layouts))                                  |
| SMTP rate limits                     | Fewer mail workers, `josk.concurrency: 1`, consider `strategy: 'backup'` with real fallback transports                     |
| Large backlog / slow SMTP            | Raise `josk.zombieTime` above worst-case `iterate` duration (Postgres drains up to **100** letters per tick, sequentially) |
| Tests                                | `retries: 0`, `mailTime.destroy()` in teardown; `josk.adapter.resetOnInit: true` dev-only                                  |

## Production JoSk block (any storage)

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

For deeper JoSk semantics — adapter internals, lease lifecycle, recurring task patterns — install the JoSk skill: **`npx skills add veliovgroup/josk`**.

## Pitfalls

- **Many `server` pods on the same `prefix`, expecting N× send rate** — they compete for one drain lease per tick. Use `concurrency` (in-process) and/or distinct `prefix`es (cluster-wide) instead. Duplicate-prefix `server` is still useful as **failover/HA** — a warm standby with a different `lockOwnerId` takes over the lease the next tick if the leader dies.
- **`zombieTime` too low** with slow storage scans — another node may start an overlapping drain. The atomic CAS on `isSending` still prevents double-send, but wasted work and SMTP pressure remain.
- **`sendingTimeout` below the worst-case SMTP roundtrip** — a healthy still-sending worker can lose its lock to a recovery worker, causing a duplicate delivery. Always keep `sendingTimeout` comfortably above the slowest legitimate roundtrip.
- **Replica reads** for queue or scheduler — use primary / writer endpoint only.
- **`josk.adapter.resetOnInit: true`** in production — wipes scheduler state on every boot.
- **`concatEmails: true` on OTP or password resets** — folds letters together. Use a separate instance (`prefix: 'otp'`) instead.

## See also

- [docs/multi-instance.md](./multi-instance.md) — running one `MailTime` per email class.
- [docs/dedicated-mail-host.md](./dedicated-mail-host.md) — 2–8 server processes on one mail VM.
- [Settings presets](../README.md#settings-presets) — the preset table.
- [JoSk skill](https://github.com/veliovgroup/josk) — `npx skills add veliovgroup/josk`.
