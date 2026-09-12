# MailTime 3.x (legacy, Node 14.20+ / 16)

Read this file instead of `api.md` / `recipes.md` / `tuning.md` when `package.json` pins `mail-time` below `4.0.0` or the runtime is Node < 20.9. `3.0.0` is the last release that runs on Node 14/16 (`engines.node >=14.20.0`); `4.0.0` and later require Node ≥ 20.9 / Bun ≥ 1.1. It pairs with `josk@^5` — read `legacy-v5.md` in the `josk` skill for the scheduler side.

## Version ladder

| mail-time | Node | josk | Notes |
|---|---|---|---|
| 1.x | ≥ 14.1 | ^3 | `new MailTime({ db })`, Date `sendAt`, no `uuid`, no `queue` option |
| **3.0.0** | ≥ 14.20 | ^5 | explicit `queue:` adapter, `josk:` required for servers, numeric `sendAt`, `uuid` — **last Node 16 release** |
| 4.0.0+ | ≥ 20.9 | ^6 | everything the rest of this skill describes |

## What 3.x does NOT have

Do not write any of these against 3.x — they are `undefined` and throw at runtime:

- Exports: `PostgresQueue`, `mailTimePreset`, `presets`, `presetNames`. Only `MailTime`, `MongoQueue`, `RedisQueue` exist.
- Methods: `ready()`, `drain()`, `destroy()`, `pause()`, `resume()`. Only `sendMail` / `send`, `cancelMail` / `cancel`, `ping`.
- Options: `concurrency`, `mode`, `sendingTimeout`, `verifyTransports`, `strictPayload`, `transportFrom`, `josk.lockOwnerId`, `useHashTags`.
- Storage: no `isSending` / `sendingAt` lock, no claim renewal, no per-recipient retries, no stale-lock recovery. Claim CAS is `isSent: true` + `tries`.
- Templates: `{{key}}` strips tags instead of HTML-escaping; `raw` is not refused.

## Exports and constructor

```js
const { MailTime, MongoQueue, RedisQueue } = require('mail-time'); // CJS
// import { MailTime, MongoQueue, RedisQueue } from 'mail-time';    // ESM
```

| Option | Default | Notes |
|---|---|---|
| `queue` | required | `new MongoQueue({ db, prefix })` or `new RedisQueue({ client, prefix })`, or a custom object with `ping, iterate, getPendingTo, push, remove, update, cancel` |
| `type` | `'server'` | `'client'` only enqueues; needs `queue` and nothing else |
| `transports` | required for server | non-empty array from `nodemailer.createTransport()` |
| `josk` | required for server | `{ adapter: { type: 'mongo', db } \| { type: 'redis', client } \| <adapter instance>, zombieTime, minRevolvingDelay, maxRevolvingDelay }`. Defaults MailTime applies: `zombieTime 32786`, `minRevolvingDelay 512`, `maxRevolvingDelay 2048`. JoSk prefix becomes `mailTimeQueue<prefix>` |
| `prefix` | `''` | one per email class; Mongo collection is `__mailTimeQueue__<prefix>` |
| `strategy` | `'backup'` | or `'balancer'` |
| `failsToNext` | `4` | backup only — see the ladder rule below |
| `retries` | — | attempts = `retries + 1`; default when absent is 60 total. **Never pass `maxTries`** (below) |
| `retryDelay` | `60000` ms | v1 name `interval` (seconds) still accepted |
| `keepHistory` | `false` | `false` removes delivered rows; `true` keeps them with terminal flags |
| `concatEmails` | `false` | fold same-`to` letters; `concatSubject`, `concatDelimiter` (`<hr>`), `concatDelay` (`60000` ms; v1 `concatThrottling` in seconds accepted) |
| `template` | `'{{{html}}}'` | `MailTime.Template` static getter/setter for the default |
| `from` | — | string or `(transport) => string`; read `transport.options.from` inside it |
| `onSent(task)` | noop | fires once on delivery |
| `onError(error, task, info)` | noop | **fires only when the letter is abandoned** — intermediate failures produce no hook call and no log unless `debug: true` |
| `revolvingInterval` | `1536` ms | JoSk tick for the drain |
| `debug` | `false` | |

Instance methods: `sendMail(opts) → Promise<string>` (uuid; `opts.html` or `opts.text` and `opts.to` required; `opts.sendAt` Date or ms; per-letter `template`, `concatSubject`), `cancelMail(uuid) → Promise<boolean>`, `ping() → Promise<{status}>`. `send` / `cancel` are aliases. The JoSk instance is `mailTime.scheduler`.

## Rules specific to 3.x

**`retries`, never `maxTries`.** The `maxTries` branch is `(opts.maxTries < 1) ? 1 : 0` — any sane value yields `0`, the drain query becomes `tries: {$lt: 0}` and the queue silently stops. Pass `retries: N` (total attempts `N + 1`).

**Transport ladder arithmetic.** In `backup` strategy the transport index advances only when `tries % failsToNext === 0`, and the letter is abandoned when `tries >= retries + 1`. With `T` transports the last one is reachable only if `failsToNext * (T - 1) < retries + 1`. Three transports with `retries: 5` need `failsToNext: 2` (tries 1–2 / 3–4 / 5–6); `failsToNext: 3` spends all six tries on the first two transports and never reaches the third.

**Serial drain.** `___iterate` claims each due row and awaits its send before the next one. `josk.zombieTime` must outlive a whole drain of the queue, not one SMTP roundtrip, or a second server re-claims mid-drain and double-sends.

**A crash mid-send loses the letter.** The claim sets `isSent: true` before the SMTP call; on failure it is reset, on success the row is removed. If the process dies in between the row stays `isSent: true` forever — there is no `sendingTimeout` recovery in 3.x. Stop consumers by letting the current drain finish (`scheduler.destroy()` then wait for in-flight `sendMail` callbacks), not with `SIGKILL`.

**No lifecycle methods.** Nothing to `await` at startup: the constructor calls `scheduler.ping()` on `nextTick` and throws if storage is unreachable. Shutdown is `mailTime.scheduler.destroy()`; there is no `drain()`.

**Single retry owner.** Custom transports must report every failure upward once (callback `error`), never re-queue internally — two retry owners for one letter is the classic duplicate-delivery bug.

## Storage shape (Mongo)

Collection `__mailTimeQueue__<prefix>`; indexes `{uuid}`, `{isSent, isFailed, isCancelled, to, sendAt}`, `{isSent, isFailed, isCancelled, sendAt, tries}`.

```js
{ uuid, sendAt: 1700000000000 /* number */, isSent: false, isFailed: false, isCancelled: false,
  tries: 0, transport: 0, template: false, concatSubject: false,
  mailOptions: [{ to, subject, html, text, messageId, ... }] }
```

The drain selects `{isSent: false, isFailed: false, isCancelled: false, sendAt: {$lte: Date.now()}, tries: {$lt: maxTries}}`. Anything writing rows by hand must match this exactly.

**Upgrading from 1.x:** v1 rows carry a `Date` in `sendAt` and no `uuid` / `isFailed` / `isCancelled`. MongoDB never compares `Date` to a number, so a 3.x consumer never selects a v1 row and a 1.x consumer never selects a 3.x row — pending mail is stranded silently in both directions. Stop every consumer, deploy every producer and consumer together, then rewrite pending rows once (`sendAt: +sendAt`, add `uuid`, `isFailed: false`, `isCancelled: false`) before starting the new consumer. Rolling back needs the reverse rewrite.

## Example — CJS server + client on Node 16

```js
const { MailTime, MongoQueue } = require('mail-time');

const transports = [primaryDirect, secondaryDirect, smtpRelay]; // nodemailer transports

const mail = new MailTime({
  type: 'server',
  prefix: 'alerts',
  queue: new MongoQueue({ db, prefix: 'alerts' }),
  josk: { adapter: { type: 'mongo', db }, zombieTime: 600_000 },
  transports,
  strategy: 'backup',
  failsToNext: 2, // 3 transports × cap 6 → last transport gets tries 5–6
  retries: 5,
  retryDelay: 35_000,
  keepHistory: false,
  from: (t) => `"App" <${t.options.from}>`,
  onSent(task) { log('sent', task.uuid); },
  onError(error, task, info) { log('abandoned', task && task.uuid, error, info); },
});

process.on('SIGTERM', () => { mail.scheduler.destroy(); /* let in-flight sends finish, then exit */ });

// In the producing app (any process, no transports, no josk):
const producer = new MailTime({ type: 'client', prefix: 'alerts', queue: new MongoQueue({ db, prefix: 'alerts' }) });
const uuid = await producer.sendMail({ to, subject, html, messageId: `<${id}@app>` });
```

No presets exist in 3.x — an OTP-style queue is a second instance with its own `prefix`, short `retryDelay`, and `concatEmails: false`.
