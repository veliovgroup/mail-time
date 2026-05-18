# Multiple MailTime instances

Email classes (OTP vs marketing vs receipts) typically need different policies — retry budgets, fold windows, concurrency. Run **one `MailTime` per class**, pick the matching [preset](../README.md#settings-presets), and supply your own `queue` / `transports` / `josk.adapter` / `prefix` on top. Keeps boilerplate to a single line per class and prevents policy from leaking across queues.

## `prefix`: when it matches vs when it splits

- **Same `prefix` on every `client` and `server` that share one logical queue** — app pods enqueue with `type: 'client'`, the mail worker drains with `type: 'server'`, both use the same `prefix` (e.g. `prefix: 'otp'`). This is the common case.
- **Different `prefix` per class** so OTP, transactional, and marketing namespaces don't collide.
- **Never** reuse the same `prefix` for two instances with different `concatEmails`, `retryDelay`, or other mail policy.

One Redis / Mongo / Postgres connection can be shared across instances.

## Three classes on one Redis

```js
import { MailTime, RedisQueue, mailTimePreset } from 'mail-time';
import { createClient } from 'redis';
import { transports, otpTransport, marketingTransport } from './transports.js';

const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();
const adapter = { type: 'redis', client: redisClient };
const lockOwnerId = `${process.env.HOSTNAME || 'mail'}-${process.pid}`;
const queue = () => new RedisQueue({ client: redisClient });

export const otpMail = new MailTime(mailTimePreset('otp', {
  type: 'server',
  prefix: 'otp',
  queue: queue(),
  transports: [otpTransport],
  josk: { adapter, lockOwnerId },
  from: (t) => `"Security" <${t.options.from}>`,
}));

export const transactionalMail = new MailTime(mailTimePreset('transactional', {
  type: 'server',
  prefix: 'transactional',
  queue: queue(),
  transports,
  josk: { adapter, lockOwnerId },
  from: (t) => `"Awesome App" <${t.options.from}>`,
}));

export const marketingMail = new MailTime(mailTimePreset('newsletter', {
  type: 'server',
  prefix: 'marketing',
  queue: queue(),
  transports: [marketingTransport],
  josk: { adapter, lockOwnerId },
  from: (t) => `"News by Awesome App" <${t.options.from}>`,
}));

await Promise.all([otpMail, transactionalMail, marketingMail].map((m) => m.ready()));

// App code picks the right queue:
await otpMail.sendMail({ to: user.email, subject: 'Sign-in code', text: code, html: codeHtml });
await marketingMail.sendMail({ to: user.email, subject: 'New features', text, html });
```

## App servers in `client` mode

App pods only enqueue. Use the **same `prefix`** as the mail worker for that class. No `transports`, no `josk`.

```js
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';

const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();

export const otpClient = new MailTime({
  type: 'client',
  prefix: 'otp',                 // matches `otpMail` server above
  queue: new RedisQueue({ client: redisClient }),
});

await otpClient.ready();
await otpClient.sendMail({ to: user.email, subject: 'Sign-in code', text: code });
```

## See also

- [Settings presets](../README.md#settings-presets) — what each preset shapes.
- [docs/dedicated-mail-host.md](./dedicated-mail-host.md) — running 2–8 server processes on one mail VM.
- [docs/tuning.md](./tuning.md) — throughput levers and pitfalls.
