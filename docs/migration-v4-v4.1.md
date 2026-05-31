# Migration guide (v4.0 → v4.1)

`v4.1.0` is additive and non-breaking. It adds reversible server backpressure and ports JoSk 6.2.0 adapter hygiene. No code changes are required to upgrade.

## What's new

- **`mailTime.pause()` / `mailTime.resume()` / `mailTime.isPaused`** — a `server` instance can stop and resume competing for the queue-drain lease without `destroy()` (permanent) or just `drain()` (waits but doesn't stop re-scanning). In-flight SMTP sends finish; peer servers keep draining. No-ops on `client` instances. Use for SMTP rate-limit backpressure, rolling deploys, and quota windows.
- **`ping().paused`** — the `MailTimePingResult` now carries `paused: boolean` for health checks.
- **`josk` floor raised to `^6.2.0`** — also auto-applies JoSk's scheduler-side Postgres (`delay` → `BIGINT`, per-prefix advisory lock) and Redis (pre-claim `executeAt`) fixes; no MailTime code change needed for those.
- **PostgreSQL queue setup lock** — `PostgresQueue` now takes a two-key, per-prefix advisory lock (`pg_advisory_lock(namespace, hash(prefix))`) at boot instead of a hardcoded single integer. Co-tenant MailTime queues with distinct prefixes no longer serialize each other's schema setup, and the lock no longer collides with other single-int `pg_advisory_lock` users in the same database.

## Upgrade steps

1. Bump `mail-time` to `^4.1.0` (`ostrio:mailer@4.1.0` on Meteor). `npm install` pulls `josk@^6.2.0`.
2. Nothing else. No schema migration: the Postgres queue table is unchanged (timestamps were already `BIGINT`); only the boot-time setup lock changed, and `__setup` remains idempotent `CREATE … IF NOT EXISTS`.
3. Adopt `pause()`/`resume()` only where you run **multiple `server` instances** on one `prefix` and want a pod to yield during saturation or maintenance.

## Rollout nuance (PostgreSQL advisory lock)

During a rolling upgrade from ≤4.0.0, an old instance (single-int lock) and a new instance (two-key lock) briefly will not mutually exclude each other's `__setup`. This is harmless: `__setup` only runs `CREATE TABLE/INDEX IF NOT EXISTS`, with no destructive `ALTER`. Once all instances are ≥4.1.0, distinct-prefix setups stop blocking one another.

## Breaking changes

None.
