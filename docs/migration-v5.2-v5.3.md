# Migrating from 5.2 to 5.3

5.3.0 changes transport verification, `drain()`, and recipient-policy address parsing. Nothing else needs changes. Full list: `CHANGELOG.md`.

## Transport verification

- `ready()` waits at most `verifyTimeout` (default 30000 ms) per transport. A `verify()` that neither calls back nor returns a Promise now delays `ready()` by that time and stays usable, with one warning. Fix such a transport so it calls the callback or returns a Promise, or set `verifyTimeout` lower.
- A sole SMTP host that accepts connections but never answers used to reject `ready()` after about 30 s (Nodemailer's default `greetingTimeout`). The 120 s figure applies only to a host that never completes the TCP connection. Now `ready()` resolves at `verifyTimeout` and the failure reaches `onError(error, null, { phase: 'verify' })` when Nodemailer reports it.
- `onError(error, null, { transportIndex, phase: 'verify' })` still means the transport is quarantined. A timeout alone does not fire it.
- A quarantined transport is re-probed in the background (60 s, doubling to 15 min) and returns to rotation after a successful `verify()`. Before, it stayed out until restart. Code that relied on restart-only recovery needs no change.
- `verifyTimeout` accepts positive numbers; values above `2147483647`, including `Infinity`, are clamped to `2147483647`. Other values use `30000`.

## drain()

`await mailTime.drain()` resolves `{ failedWrites }` (was `undefined`). Storage write failures while recording a send outcome also call `onError` with `details.phase` `'complete'` or `'checkpoint'`.

## Recipient policies: display names

With `recipientPolicies`, a display name that contains an unquoted `@`, `[`, `]`, `\`, `(` or `)` is now rejected. 5.2.1 accepted it. Quote the name:

```js
// rejected in 5.3: to: 'a@b.com <c@d.com>'
to: '"a@b.com" <c@d.com>'
// rejected in 5.3: to: 'John (Sales) <x@y.com>'
to: '"John (Sales)" <x@y.com>'
```
