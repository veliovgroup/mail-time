---
name: mail-time
description: Use when building, wiring, reviewing, or debugging MailTime and ostrio:mailer email queues for horizontally scaled Node.js, Bun, or Meteor apps. Trigger on MailTime, MongoQueue, RedisQueue, PostgresQueue, mailTimePreset, JoSk email scheduling, scheduled mail, retries, sendAt, concatEmails, multi-SMTP backup or balancer, client/server mail workers, dedicated mail hosts, graceful shutdown, pause/resume, custom queue adapters, duplicate sends across PM2/Kubernetes/ECS, partial-recipient delivery, claim renewal, sendingTimeout, strictPayload, raw/template escaping, transportFrom, OTP versus marketing policies, email outbox/HA sending, or migrations from Agenda, Bull, BullMQ, Bree, and sendgrid-queue.
---

# MailTime

Storage-backed email queue built on JoSk. `server` drains and sends; `client` only enqueues. MongoDB, Redis, PostgreSQL, or custom queue.

## Reference map

- API, types, errors, payload policy: `references/api.md`
- Adapter choice, schema, custom CAS contract: `references/adapters.md`
- Topology, presets, throughput, timeouts: `references/tuning.md`
- Runnable setups and shutdown: `references/recipes.md`

Read only reference matching task. Deep JoSk semantics need `josk` skill.

## Minimal shape

```js
new MailTime({
  type: 'server' | 'client',
  queue: new <Mongo|Redis|Postgres>Queue({ client|db }),
  transports, // server only
  josk: { adapter: { type, client|db }, lockOwnerId }, // server only
  prefix: 'otp',
})
```

Core rules:

- Same logical queue uses same `prefix` on every client/server. Different policy or shard uses different prefix.
- One JoSk lease winner per prefix/tick. More same-prefix servers add HA, not throughput. Raise MailTime `concurrency` or shard prefixes.
- Postgres fits multi-DC/strongest consistency. Redis fits single-region throughput and requires `watch()` + `multi()`. Mongo fits Mongo/Meteor apps and official driver.
- Use `mailTimePreset`: `transactional`, `otp`, `newsletter`, `marketing`, `notifications`, `alerts`.
- Graceful shutdown: `await destroy({ drain: true })`. Plain `destroy()` aborts completion writes.
- SMTP delivery has unavoidable at-least-once ambiguity if acceptance succeeds but completion write is lost.

## Red flags

- Active-active Redis, replica reads, reused prefix with different policies.
- `concatEmails` on OTP/password reset.
- `sendingTimeout` below storage/SMTP conditions; v5 warns below 120s and renews active claims.
- `{{key}}` for trusted HTML. Use `{{{key}}}` only for produced markup.
- `transport.options.from` in callback. Use `details.from`.
- Custom adapter skipping lease guards or calling `___send` instead of `___dispatch`.
- Missing `onSent`/`onError`, `ready()`, or shutdown.

## Runtime

Node ≥20.9, Bun ≥1.1, Meteor 2.14/3.2. ESM + CJS. Runtime dependency: JoSk. Install nodemailer plus chosen store driver.
