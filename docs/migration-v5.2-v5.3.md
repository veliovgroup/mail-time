# Migrating from 5.2 to 5.3

5.3.0 changes transport verification, `drain()`, and recipient-policy address parsing. It also lowers `engines.node` to `>=14.19.3` and requires `josk@^6.5.0` (which declares `>=14.21.3`; see "Supported runtimes" in the README). Nothing else needs changes. Full list: `CHANGELOG.md`.

## Transport verification

- `ready()` waits at most `verifyTimeout` (default 30000 ms) per transport. A `verify()` that neither calls back nor returns a Promise now delays `ready()` by that time and stays usable, with one warning. Fix such a transport so it calls the callback or returns a Promise, or set `verifyTimeout` lower.
- A sole SMTP host that accepts connections but never answers used to reject `ready()` after about 30 s (Nodemailer's default `greetingTimeout`). The 120 s figure applies only to a host that never completes the TCP connection. Now `ready()` resolves at `verifyTimeout` and the failure reaches `onError(error, null, { phase: 'verify' })` when Nodemailer reports it.
- `onError(error, null, { transportIndex, phase: 'verify' })` still means the transport is quarantined. A timeout alone does not fire it.
- A quarantined transport is re-probed in the background (60 s, doubling to 15 min, one probe in flight per transport; from 5.3.1 a probe that times out releases its slot) and returns to rotation after a successful `verify()`. Before, it stayed out until restart. Code that relied on restart-only recovery needs no change. Details: `docs/transport-verification.md`.
- `verifyTimeout` accepts positive numbers; values above `2147483647`, including `Infinity`, are clamped to `2147483647`. Other values use `30000`.

## drain()

`await mailTime.drain()` resolves `{ failedWrites }` (was `undefined`). Storage write failures while recording a send outcome also call `onError` with `details.phase` `'complete'` or `'checkpoint'`. An outcome write lost after a claim-renewal error is retried once (no retry when the claim was already stale at renewal time) and, if still lost, reported the same way. In recipient-policy mode a claim-renewal write that throws now stops further renewals only; the outcome write still runs (5.2 closed the lease and left the row `sending`).

## Recipient policies: validation moves earlier

On an instance configured with `recipientPolicies`, `sendMail()` now rejects an unparseable address before enqueue (5.2 enqueued it and reported the failure through `onError` at send time). Wrap `sendMail()` in `try/catch` if you rely on the task existing. A `server` instance throws at construction when a string `from` or a transport's `from` does not parse; fix the address or move the display name into `{ name, address }`.

## Recipient policies: display names

With `recipientPolicies`, every address string 5.2.1 accepted still works, and quoted display names such as `"Doe, John" <user@example.com>` now work too. One object form is tightened: `{ address: 'Name <user@example.com>' }` (accepted by 5.2.1, rendered as a malformed header by Nodemailer) now fails with `MAIL_TIME_INVALID_ADDRESS`; use `{ name: 'Name', address: 'user@example.com' }`.

A display name with an unquoted `@`, `[`, `]`, `\`, `(` or `)` is sent quoted, so the header text changes:

```js
to: 'John (Sales) <x@y.com>'
// 5.2: To: John <x@y.com>
// 5.3: To: "John (Sales)" <x@y.com>
```
