# Changelog

## v5.0.0 (unreleased)

Closes three duplicate-delivery paths, one wrong-identity path, and one queue-trust path. Storage schema and the adapter contract are unchanged — rolling upgrades from 4.1 are safe. Full guide: [docs/migration-v4.1-v5.md](docs/migration-v4.1-v5.md).

### Changed defaults

- **Claims are renewed while the send is in flight.** `sendingAt` used to be stamped once at claim time, so any send slower than `sendingTimeout` lost its lock to a recovery worker and the letter went out twice. New `renewClaim` (default `sendingTimeout / 3`) re-stamps it through the existing lease-guarded update; `maxRenewals` (default `10`) bounds it so a wedged send is still recovered. `renewClaim: false` restores v4.1.
- **`{{key}}` HTML-escapes instead of stripping tags.** The strip pass needed a closing `>`, so an unterminated `<a href="…` survived into the rendered body. Escaping applies to HTML contexts only (`html`, `template`, `concatDelimiter`); `text` bodies and subject headers now interpolate verbatim instead of being stripped. `{{{key}}}` is unchanged.
- **`MailTime.Template` no longer interpolates `{{{subject}}}` into its heading** — a queued subject reached the rendered body raw. It now uses `{{subject}}`.
- **`raw` is refused.** `sendMail({ raw })` throws, and `raw` is stripped from any letter already in storage. It bypassed composition (`template`, `concatEmails`, `from()` silently stopped applying) and nodemailer let a message-level `raw` bypass `disableFileAccess`/`disableUrlAccess` before 9.0.1 (GHSA-p6gq-j5cr-w38f).
- **`otp` and `alerts` presets raise `sendingTimeout` 60s → 120s**, and the constructor warns below `120000`.

### Added

- **`shouldFailOver(error, info, email)`** — veto rotating to the next transport for a failure that may already have been delivered. A transport can also tag its own error with `mayFailOver: false`. Default behaviour is unchanged.
- **`strictPayload` / `allowedMailFields`** — narrow every queued letter to an allowlist and force `disableFileAccess` / `disableUrlAccess`. Off by default so documented `attachments` usage keeps working.
- **`from(transport, details)`** — the callback now receives `{ index, from }`. `transport.options.from` is always `undefined` for a class-instance transporter (nodemailer's `Mail.options` is `{}` there), so the documented pattern silently sent every letter under the fallback identity. `MailTime.transportFrom(transport)` exposes the same resolution.

### Internal

- `nodemailer` dev dependency moved to `^9.0.5`; suites pass against it.

---

For full changelog see [releases](https://github.com/veliovgroup/mail-time/releases) in GitHub