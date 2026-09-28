# Changelog

## 5.2.1

- `destroy({ drain: true })` resolves `true` after a clean drain when the queue scan waited behind in-flight SMTP. `destroy()` and `pause()` drop sends still waiting for a `concurrency` slot; their rows stay unclaimed.
- Shipped runtime files parse as ES2020: removed logical assignment (`??=`) and numeric separators.

## 5.2.0

- Opt-in recipient policies, durable mixed outcomes, and grouped terminal callbacks.
- JoSk 6.4 upgrade, graceful scheduler shutdown, completed-recipient recovery, and Redis 4 Cluster compatibility.
- Send-claim renewal continues during `destroy({ drain: true })`.

## 5.1.0

- RedisQueue: opt-in Redis Cluster support via tagged Lua queue state.

For full changelog see [releases](https://github.com/veliovgroup/mail-time/releases) in GitHub
