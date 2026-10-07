# Transport verification

`verifyTransports: true` (default) probes every transport with `transport.verify()` at `ready()` and keeps probing quarantined transports in the background. `type: 'client'` instances never probe.

## How a probe is decided

MailTime always calls `verify(callback)` with a `(error, success) => void` callback. The first of these decides the probe:

- the callback (`error` set means failure; `success === false` is ignored),
- a returned thenable (rejection means failure),
- a synchronous throw (failure),
- a synchronous `true` or `false` return (both healthy; Nodemailer's `Mailer#verify` returns `false` when the underlying transport has no `verify` method, as with `jsonTransport`, `streamTransport` and `sendmail`).

Any other synchronous return value is ignored, so a callback that reports later still counts. Transports without a `verify()` method are healthy.

## Timeout

`verifyTimeout` (default `30000` ms) bounds how long `ready()` waits per transport and how long each background re-probe waits. Positive numbers are accepted; values above `2147483647`, including `Infinity`, are clamped to that maximum. Anything else (non-number, `0`, negative, `NaN`, a numeric string) uses `30000`. There is no "wait forever" value.

On timeout `ready()` stops waiting, logs one warning, and the transport keeps its current health. `onError` is not called. A verdict that arrives later still applies: a late success clears a quarantine, a late failure quarantines the transport and calls `onError` once. A verdict from a probe that a newer probe of the same transport has superseded is ignored, and so is any verdict after `destroy()`.

A `verify()` that neither calls back nor returns a Promise delays `ready()` by `verifyTimeout` and the transport stays usable.

A sole SMTP host that accepts TCP connections but never answers resolves `ready()` after `verifyTimeout` and stays usable; Nodemailer's own `greetingTimeout` later surfaces the failure through `onError`.

## Quarantine

A failed probe quarantines the transport: it is skipped during rotation (`strategy: 'balancer'`) and fallback (`strategy: 'backup'`), and `onError(error, null, { transportIndex, phase: 'verify' })` fires once per quarantine episode. `ready()` throws only when every transport fails.

## Recovery

A quarantined transport is re-probed in the background once its backoff elapses. Backoff starts at 60 s, doubles per failed or timed-out probe, and caps at 15 min (no option). Probes start from the scheduler scan and from the send path, so recovery does not depend on any row selecting the quarantined transport. Sends never wait for a probe.

One probe is in flight per transport at a time. A probe that reaches `verifyTimeout` without a verdict releases its slot and counts as a failed attempt (5.3.1+; 5.3.0 kept the slot until the verdict arrived, so a `verify()` that never settled pinned the transport in quarantine). Its late verdict still applies unless a newer probe has started.

A successful probe returns the transport to rotation and logs one line. Under `strategy: 'backup'` new sends route back to a recovered primary. Failures write to the debug log only.

No probes run for `verifyTransports: false`, `type: 'client'`, or after `destroy()`.
