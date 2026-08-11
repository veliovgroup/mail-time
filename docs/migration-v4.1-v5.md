# Migration guide (v4.1 → v5.0)

`v5.0.0` closes three ways one queued letter could reach a recipient twice, one way it could be sent under the wrong identity, and one way a queue writer could reach further than "send an email". Most apps upgrade with **no code change**; four defaults changed, and one of them is visible in rendered HTML.

Storage schema is unchanged — no migration, no adapter rewrite, rolling upgrades are safe (a v4.1 and a v5.0 instance can drain the same queue side by side).

## Changed defaults

### 1. A claim is renewed while its SMTP roundtrip runs

**Was:** `sendingAt` was stamped once, at claim time. A send slower than `sendingTimeout` lost its lock to a "recovery" worker, which then delivered the same letter again. The only lever was a `sendingTimeout` large enough for the worst case — which made genuine crash recovery equally slow.

**Now:** while a send is in flight, MailTime re-stamps `sendingAt` every `renewClaim` ms (default `sendingTimeout / 3`) with a lease-guarded update that succeeds only while this worker still owns the row. Renewals are capped by `maxRenewals` (default `10`), so a genuinely wedged send is still recovered — worst case `sendingTimeout + maxRenewals × renewClaim` instead of `sendingTimeout`.

**If you relied on the old recovery latency:** `renewClaim: false` restores v4.1 exactly. Lower `maxRenewals` to tighten the ceiling without giving up renewal.

### 2. `{{key}}` escapes HTML instead of stripping tags

**Was:** `{{key}}` ran `.replace(/<(?:.|\n)*?>/gm, '')` over the value. That is not a safety net — the pass needs a closing `>`, so an unterminated `<a href="https://evil.example"` survived into the rendered body and became a live anchor once the template wrapped it. The bundled `MailTime.Template` also interpolated `{{{subject}}}` (triple brace) into its `<h1>`, so a queued subject reached the body completely raw.

**Now:**

- `{{key}}` is **HTML-escaped** in HTML contexts — `html`, `template`, `concatDelimiter`.
- `{{key}}` interpolates **verbatim** in `text` bodies and in subject headers. Neither is HTML; the old strip mangled legitimate content like `x < y` or `<ops@example.com>`.
- `{{{key}}}` is unchanged: always verbatim.
- `MailTime.Template` now uses `{{subject}}` in its heading.

**If you relied on tag-stripping,** strip before you enqueue. If you were passing HTML through `{{key}}` on purpose, switch that placeholder to `{{{key}}}` — and make sure the value is yours, not a caller's.

### 3. `raw` is refused

`sendMail({ raw })` now throws, and a `raw` field on a letter already in storage is stripped before send. `raw` bypasses composition, so `template`, `concatEmails` and the `from()` callback silently stopped applying — and nodemailer let a message-level `raw` bypass `disableFileAccess` / `disableUrlAccess` before 9.0.1 (GHSA-p6gq-j5cr-w38f). Pass `html` / `text`.

### 4. `otp` and `alerts` presets raise `sendingTimeout` to 120 s

Both shipped `60_000`, below a realistic SMTP roundtrip once MX rollover is involved — the exact condition that produced duplicate sends. MailTime now also logs a warning when any instance is configured below `120_000`.

**If you had pinned 60 s deliberately,** pass `sendingTimeout` explicitly in your preset overrides; the warning is advisory, not enforced.

## New, opt-in

### `shouldFailOver(error, info, email)`

With `strategy: 'backup'`, a transport was abandoned for the next one after `failsToNext` consecutive failures — on *any* error. That is wrong when the receiving MTA may already hold the message: a socket that dies during `DATA` is indistinguishable from one that dies before it, and re-sending through a second provider delivers the letter twice.

```js
new MailTime({
  // ...
  shouldFailOver(error, info, email) {
    return error?.code !== 'EMESSAGE';   // never cross providers once the body is on the wire
  },
});
```

A transport can also tag its own error with `mayFailOver: false`. The hook overrides the tag; both default to today's behaviour (rotate), so doing nothing changes nothing.

### `strictPayload` / `allowedMailFields`

MailTime exists so *other processes* enqueue over shared storage — which means anything that can write to that storage inherits nodemailer's capability surface (`attachments[].path` reads local files, `attachments[].href` fetches URLs, `envelope` / `dkim` rewrite who the message authenticates as).

```js
new MailTime({
  // ...
  strictPayload: true,                  // allowlist + disableFileAccess/disableUrlAccess
  allowedMailFields: ['attachments'],   // opt a field back in, deliberately
});
```

Off by default so `attachments` keep working as documented. Turn it on whenever the queue storage is reachable by more than your own application.

### `from(transport, details)` and `MailTime.transportFrom()`

The `from()` callback now receives a second argument: `{ index, from }`.

```js
// Before — silently `undefined` for class-instance transports:
from: (transport) => `"Acme" <${transport.options.from}>`,

// After:
from: (transport, details) => `"Acme" <${details.from}>`,
```

`nodemailer.createTransport()` only populates `.options` for *plain-object* configs. For a class-instance transporter — anything with its own `.send()`, which covers most custom and direct-MX transports — nodemailer's internal `Mail.options` is always `{}`, so `transport.options.from` read `undefined` and every letter went out under whatever your fallback was. `MailTime.transportFrom(transport)` exposes the same resolution (`options.from` → `transporter.options.from` → `_defaults.from` → `_options.from`) if you need it elsewhere.

Single-argument callbacks keep working; nothing breaks until you want the fix.

## Upgrade steps

1. Bump `mail-time` to `^5.0.0` (`ostrio:mailer@5.0.0` on Meteor).
2. Grep your templates for `{{` placeholders that carry HTML on purpose and switch those to `{{{`.
3. Grep for `transport.options.from` inside a `from()` callback and switch to `details.from`.
4. If you enqueue `raw`, move to `html` / `text`.
5. Optional: turn on `strictPayload` if the queue storage isn't private to your app; add `shouldFailOver` if your transport can tell "never delivered" from "may have been delivered".

## Not changed

- Storage schema and the queue adapter contract (`docs/queue-api.md`).
- Claim CAS semantics — renewal reuses the existing lease-guarded update path, so custom adapters written against v4 need no change.
- `retries` / `retryDelay` / `concatEmails` / `mode` / `concurrency` / `pause()` / `resume()` behaviour.
