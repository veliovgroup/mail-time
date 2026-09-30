# Changelog

## 5.3.0

Transport verification

- New `verifyTimeout` option (default `30000` ms). Positive numbers are accepted; values above `2147483647`, including `Infinity`, are clamped to `2147483647`. Anything else (non-number, `0`, negative, `NaN`, a numeric string) uses `30000`. There is no "wait forever" value. The timer is unref'd and cleared on `destroy()`.
- `verifyTransports` always passes a callback to `transport.verify(callback)`, so callback-only custom transports verify correctly. The first of the callback, a returned thenable, a synchronous throw, or a synchronous `true`/`false` return decides the probe. `false` is what Nodemailer's `Mailer#verify` returns when the underlying transport has no `verify` method (`jsonTransport`, `streamTransport`, `sendmail`), and counts as healthy. Any other synchronous return value is ignored, so a callback that reports an error later still counts.
- Behavior change: a `verify()` that neither calls back nor returns a Promise (including a synchronous `verify()` that returns `undefined` and ignores its callback) now delays `ready()` by `verifyTimeout` and then stays usable. It logs one warning and does not call `onError`.
- Behavior change: a timeout no longer marks the transport unusable. `ready()` stops waiting; health stays as it was. A verdict that arrives later still applies: a late success clears a quarantine, a late failure quarantines the transport and calls `onError(error, null, { phase: 'verify' })` once. A newer probe of the same transport always wins over an older late result. Verdicts after `destroy()` are ignored.
- Behavior change: a sole SMTP host that accepts connections but never answers (blackhole) resolves `ready()` after `verifyTimeout` and stays usable. Before, `ready()` rejected after about 30 s (Nodemailer's default `greetingTimeout`). The roughly 120 s figure applies only to a host that never completes the TCP connection. The failure still surfaces through `onError` when Nodemailer reports it after the timeout.
- Quarantined transports recover. When a send or rotation check finds a quarantined transport whose backoff has elapsed, one background `verify()` probe starts without delaying the send. Backoff starts at 60 s, doubles per failed or timed-out probe, and caps at 15 min (no option). Success returns the transport to rotation and logs one line. Under `strategy: 'backup'`, new sends route back to the recovered primary. Failures write to the debug log only. `onError` fires once per quarantine episode. No probes for `type: 'client'`, `verifyTransports: false`, or after `destroy()`. Before, a transport that failed verification stayed unusable until restart. Probes are single-flight: a probe that times out stays in flight until its verdict arrives, so at most one `verify()` is outstanding per transport; the late verdict then applies and, on failure, doubles the backoff.

Completion writes and drain

- `drain()` resolves `{ failedWrites }` instead of `undefined`. `failedWrites` counts failures while recording a send outcome (a storage write that threw, or an outcome write lost after a claim-renewal error), cumulatively since the instance was created, and still counts after a plain `destroy()`.
- `onError(error, task, details)` fires once for each such write failure with `details.phase` of `'complete'` (final or retry-release write) or `'checkpoint'` (recipient-policy results written after SMTP). Previously the failure was only logged, so a shutdown drain looked clean while the row stayed `sending` and was re-sent after `sendingTimeout`. Delivery stays at-least-once. After a plain `destroy()` the failure is still counted but `onError` is not called.
- Recipient-policy mode: a claim-renewal write that throws stops further renewals only. The outcome write still runs. Before, the lease closed, no outcome was written, and the row stayed `sending` with no `onError` and `failedWrites` at 0, which produced a silent duplicate send later.
- Both modes: a claim-renewal write that throws may have been applied by storage, which made the outcome write fail its lease guard silently. MailTime now retries the outcome write once with the attempted renewal stamp (a peer takeover bumps `tries` or stamps a later `sendingAt` while the lease is live, so the retry cannot match a taken-over row; a claim that was already stale at renewal time is reported without a retry). A clean recovery reports nothing. If the retry fails too, `onError` receives `outcome write lost (renewal outcome uncertain or lease taken over)` with `details.phase` `'complete'` or `'checkpoint'` and `failedWrites` increments.

Runtimes

- `engines.node` is `>=14.19.3` (was `>=20.9.0`). The package loads and passes 12 send, shutdown and drain checks from a packed tarball on Node 14.19.3, 14.21.3, 16.20.2, 18.19.1, 20.11.1, 22.21.1, 24.16.0 and Bun. Node 12 cannot parse it. `josk` 6.5.0 declares `>=14.21.3`, so engine-strict installs need Node 14.21.3+. See "Supported runtimes" in the README.
- `josk` dependency raised to `^6.5.0` (was `^6.4.0`).

Recipient policies (prepared as 5.2.2, folded into 5.3.0)

- Recipient policies accept RFC 5322 display names with quoted parts, such as `"ostr.io" <no-reply@ostr.io>`, `"Doe, John" <user@example.com>` and `"A \"B\" C" <user@example.com>`. 5.2.1 rejected them before SMTP.
- Display names that contain an unquoted `@`, `[`, `]`, `\`, `(` or `)`, such as `a@b.com <c@d.com>` or `John (Sales) <x@y.com>`, are sent with the name quoted (`"John (Sales)" <x@y.com>`), so the header shows the mailbox the policy checked. 5.2.1 accepted these but sent the raw string, which Nodemailer rendered without comments, or without the address at all after an unbalanced `(`. Stored `mailOptions` keep the original string. Unquoted `<`, `>`, `:`, `;` and `,` in a display name stay rejected. Without `recipientPolicies` nothing changes.
- Address errors name the actual field (`from`, `to[1]`, `envelope.from`, and so on) through `error.field` and `error.code === 'MAIL_TIME_INVALID_ADDRESS'`. 5.2.1 blamed `envelope.to` for every field. Messages never include the address or display name.
- An unparseable address fails the task on its current attempt with a logged diagnostic and `onError`, instead of silently retrying until `maxTries`.
- Behavior change: on an instance configured with `recipientPolicies`, `sendMail()` validates `from`, `sender`, `replyTo`, `to`, `cc`, `bcc`, `envelope.from` and `envelope.to` and rejects with `MAIL_TIME_INVALID_ADDRESS` before enqueue. A `server` constructor throws for an unparseable string `from` or transport `from` (`error.field` is `transports[i].from`). Letters that reach the queue from an instance without `recipientPolicies` still fail at send time as above.

Types

- New `MailTimeErrorDetails` type for `onError`'s third argument: `{ phase?: 'verify' | 'complete' | 'checkpoint', transportIndex?: number, attempt?: number }` plus the SMTP `info` keys of a failed attempt (was `object`).
- Line breaks and NUL characters in `{ name }` objects are rejected like those in address strings.
- `{ name, address }` objects must carry a bare address in `address`, matching Nodemailer's contract. 5.2.1 also accepted `{ address: 'Name <user@example.com>' }` and sent a malformed header; 5.3.0 rejects it with `MAIL_TIME_INVALID_ADDRESS`. Move the display name to `name`.

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
