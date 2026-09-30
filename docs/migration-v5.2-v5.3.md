# Migrating from 5.2 to 5.3

5.3.0 changes transport verification, `drain()`, and recipient-policy address parsing. Nothing else needs changes. Full list: `CHANGELOG.md`.

## Transport verification

- `ready()` waits at most `verifyTimeout` (default 30000 ms) per transport. A `verify()` that neither calls back nor returns a Promise now delays `ready()` by that time and stays usable, with one warning. Fix such a transport so it calls the callback or returns a Promise, or set `verifyTimeout` lower.
- A sole SMTP host that accepts connections but never answers used to reject `ready()` after about 30 s (Nodemailer's default `greetingTimeout`). The 120 s figure applies only to a host that never completes the TCP connection. Now `ready()` resolves at `verifyTimeout` and the failure reaches `onError(error, null, { phase: 'verify' })` when Nodemailer reports it.
- `onError(error, null, { transportIndex, phase: 'verify' })` still means the transport is quarantined. A timeout alone does not fire it.
- A quarantined transport is re-probed in the background (60 s, doubling to 15 min) and returns to rotation after a successful `verify()`. Before, it stayed out until restart. Code that relied on restart-only recovery needs no change.
- `verifyTimeout` accepts positive numbers; values above `2147483647`, including `Infinity`, are clamped to `2147483647`. Other values use `30000`.

## drain()

`await mailTime.drain()` resolves `{ failedWrites }` (was `undefined`). Storage write failures while recording a send outcome also call `onError` with `details.phase` `'complete'` or `'checkpoint'`. An outcome write lost after a claim-renewal error is retried once (no retry when the claim was already stale at renewal time) and, if still lost, reported the same way.

## Recipient policies: display names

With `recipientPolicies`, every address 5.2.1 accepted still works, and quoted display names such as `"Doe, John" <user@example.com>` now work too. No code change is needed.

A display name with an unquoted `@`, `[`, `]`, `\`, `(` or `)` is sent quoted, so the header text changes:

```js
to: 'John (Sales) <x@y.com>'
// 5.2: To: John <x@y.com>
// 5.3: To: "John (Sales)" <x@y.com>
```
