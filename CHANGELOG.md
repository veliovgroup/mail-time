# Changelog

## Unreleased

- `engines.node` is `>=14.19.3` (was `>=20.9.0`). The package loads and passes 12 send, shutdown and drain checks from a packed tarball on Node 14.19.3, 14.21.3, 16.20.2, 18.19.1, 20.11.1, 22.21.1, 24.16.0 and Bun. Node 12 cannot parse it. `josk` still declares `>=20.9.0`, so engine-strict installs need Node 20.9+. See "Supported runtimes" in the README.
- `verifyTransports` passes a callback to `transport.verify(callback)`, so callback-only custom transports verify correctly. Nodemailer's contract (callback or returned Promise) is the supported contract. The first of callback, Promise or timeout settles the probe.
- New `verifyTimeout` option (default `30000` ms). A `verify()` that never settles marks the transport unhealthy instead of blocking `ready()` forever.
- `drain()` resolves `{ pending, failedWrites }` instead of `undefined`. `failedWrites` counts storage writes that threw while recording a send outcome.
- `onError(error, task, details)` fires once for each such write failure with `details.phase` of `'complete'` (final or retry-release write) or `'checkpoint'` (recipient-policy results written after SMTP). Previously the failure was only logged, so a shutdown drain looked clean while the row stayed `sending` and was re-sent after `sendingTimeout`. Delivery stays at-least-once.

## 5.2.2

- Recipient policies accept RFC 5322 display names: quoted names with commas, escaped quotes, or specials, such as `"ostr.io" <no-reply@ostr.io>` and `"Doe, John" <user@example.com>`. 5.2.1 rejected them before SMTP.
- Address errors name the actual field (`from`, `to[1]`, `envelope.from`, …) through `error.field` and `error.code === 'MAIL_TIME_INVALID_ADDRESS'`. 5.2.1 blamed `envelope.to` for every field. Messages never include the address or display name.
- An unparseable address fails the task on its current attempt with a logged diagnostic and `onError`, instead of silently retrying until `maxTries`.
- Line breaks and NUL characters in `{ name }` objects are rejected like those in address strings.

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
