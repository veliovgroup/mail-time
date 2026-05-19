# MailTime public API reference

Every public surface of the `mail-time` NPM package. Pair with `adapters.md` for queue-specific options and `recipes.md` for end-to-end examples.

## Imports

```js
// ESM (Node ≥ 20.9.0 / Bun ≥ 1.1.0)
import {
  MailTime,
  MongoQueue,
  RedisQueue,
  PostgresQueue,
  mailTimePreset,
  presets,
  presetNames,
} from 'mail-time';

// CommonJS
const {
  MailTime,
  MongoQueue,
  RedisQueue,
  PostgresQueue,
  mailTimePreset,
  presets,
  presetNames,
} = require('mail-time');

// TypeScript — all public types are exported
import type {
  MailTimeOptions,
  MailTimeMailOptions,
  MailTimeJoSkOptions,
  MailTimeTask,
  MailTimePingResult,
  CustomQueue,
} from 'mail-time';

// ESM subpath imports (Node ≥ 20.9.0 / Bun ≥ 1.1.0)
import { mailTimePreset } from 'mail-time/presets';
import { MongoQueue } from 'mail-time/adapters/mongo';
import { RedisQueue } from 'mail-time/adapters/redis';
import { PostgresQueue } from 'mail-time/adapters/postgres';
```

Subpath exports are ESM-only. CJS consumers import everything from the main entry (`require('mail-time')`), which bundles presets and all adapters.

## `new MailTime(opts)`

Constructor. The scheduler starts immediately when `opts.type === 'server'`.

### Required options

| Option | Type | Notes |
|---|---|---|
| `queue` | `MongoQueue \| RedisQueue \| PostgresQueue \| CustomQueue` | The storage adapter for emails. |

### Server-only required options

(Required when `type` is unset or `'server'`.)

| Option | Type | Notes |
|---|---|---|
| `transports` | `Transport[]` | Non-empty array. Each entry is a nodemailer transport, plus a `.options` field carrying `from` and (optional) `mailOptions` defaults. |
| `josk` | `MailTimeJoSkOptions` | Must include `adapter`. See "JoSk integration" below. |

### Common options

| Option | Type | Default | Notes |
|---|---|---|---|
| `type` | `'server' \| 'client'` | `'server'` | `client` only enqueues; `server` enqueues and sends. |
| `prefix` | `string` | `''` | Isolates this instance's storage from siblings in the same store. |
| `from` | `string \| (transport) => string` | — | Strongly recommended for spam-passing `From:` formatting. Function form receives the chosen transport so you can build `"App" <user@transport-domain>`. |
| `strategy` | `'backup' \| 'balancer'` | `'backup'` | Multi-SMTP rotation policy. See SKILL.md. |
| `failsToNext` | `number` | `4` | (`backup` only) failures-in-a-row before rotating transport. |
| `retries` | `number` | `60` | Re-send attempts on failure. The first attempt counts; `retries: 0` ⇒ one attempt total. |
| `retryDelay` | `number` (ms) | `60000` | Wait between re-send attempts. |
| `keepHistory` | `boolean` | `false` | When `true`, sent / failed / cancelled rows stay in storage instead of being deleted. |
| `concatEmails` | `boolean \| { subject?: string }` | `false` | Fold multiple emails to the same `to` into one. Pass `{ subject: 'X' }` to set the folded-letter subject inline; the string supports the `{{count}}` placeholder (rendered to the number of folded letters) and overrides `concatSubject`. |
| `concatSubject` | `string` | `'Multiple notifications'` | Subject when folding. Supports `{{count}}` for the folded letter count. |
| `concatDelimiter` | `string` | `'<hr>'` | HTML/plain separator between folded bodies. |
| `concatDelay` | `number` (ms) | `60000` | How long the fold window is open from each new email. |
| `revolvingInterval` | `number` (ms) | `1536` | JoSk task interval that drives queue iteration. |
| `mode` | `'one' \| 'batch'` | `'batch'` | `'batch'`: drain every due-and-unclaimed row per tick. `'one'`: claim a single row per tick (fairness across cluster nodes). Mirrors JoSk's `execute`. |
| `concurrency` | `number` | `1` | Parallel SMTPs per instance, gated by an internal worker pool. The CAS on `isSending` prevents duplicate delivery even when concurrency > 1. |
| `sendingTimeout` | `number` (ms) | `300000` | How long an `isSending=true` row remains locked before it becomes eligible for recovery. Must exceed the worst-case SMTP roundtrip; lower only when sends are guaranteed to finish faster. |
| `verifyTransports` | `boolean` | `true` | Probe each transport via `transport.verify()` once at `ready()`. Failing transports are marked unusable (skipped during rotation/fallback) and surfaced through `onError(err, null, { transportIndex, phase: 'verify' })`. `ready()` rejects if every transport fails. Transports without a `verify()` method are treated as healthy. Set to `false` to disable. |
| `template` | `string` | `'{{{html}}}'` | Mustache-like default template wrapping every letter. |
| `debug` | `boolean` | `false` | Verbose logs. |
| `onSent` | `(task, info?) => void` | — | Called **once** after every recipient is accepted (full delivery). Not called per attempt or per partially-accepted recipient — see "Per-recipient delivery state" below. |
| `onError` | `(error, email, details?) => void` | — | Called after the final retry attempt fails. Also fires once per transport that fails `verify()` at startup, with `email === null` and `details = { transportIndex, phase: 'verify' }`. |

### JoSk integration (`opts.josk`)

Pass-through to the underlying `JoSk` constructor. The most useful keys:

| Option | Default in MailTime | Notes |
|---|---|---|
| `adapter` | — (required) | Either a constructed adapter instance (`new RedisAdapter({...})`) **or** a config object `{ type: 'redis'\|'mongo'\|'postgres', client \| db, prefix?, resetOnInit? }`. MailTime constructs the adapter from the config object. |
| `adapter.type` | — | One of `'redis'`, `'mongo'`, `'postgres'`. |
| `adapter.client` / `adapter.db` | — | Already-connected `redis` client / `pg.Pool` / Mongo `Db`. |
| `adapter.prefix` | `'mailTimeQueue<MailTime.prefix>'` | Defaulted from `MailTime.prefix`. |
| `adapter.resetOnInit` | `false` | Wipes current-prefix schedule on boot. Dev/test only. |
| `minRevolvingDelay` | `512` | Lower bound of randomized poll window. |
| `maxRevolvingDelay` | `2048` | Upper bound. |
| `zombieTime` | `60000` | Re-claim if `queue.iterate()` exceeds this. Do not go below 60s. |
| `execute` | `'batch'` | Low impact — MailTime registers one JoSk interval per instance. |
| `concurrency` | `Infinity` | Cap overlapping JoSk handler runs on this process (`1` if ticks pile up). |
| `lockOwnerId` | (JoSk default `'josk-<uuid>'`) | Stable owner id; recommended for observability. |
| `onError` | (default routes to `console.error` via MailTime) | `(title, { description, error, uid, task? }) => void`. |

### Constructor errors (thrown synchronously)

| Trigger | Message |
|---|---|
| `opts` missing or not an object | `[mail-time] Configuration object must be passed into MailTime constructor` |
| `opts.queue` missing or wrong shape | `[mail-time] {queue} option is required` |
| Queue adapter missing required methods | `[mail-time] {queue} instance is missing {<method>} method that is required!` |
| `type === 'server'` + empty `transports` | `[mail-time] {transports} is required for {type: "server"}` |
| `type === 'server'` + missing `josk` | `[mail-time] {josk} option is required {object} for {type: "server"}` |
| `type === 'server'` + missing `josk.adapter` | `[mail-time] {josk.adapter} option is required {object}` |
| `josk.adapter.type === 'mongo'` + no `db` | `[mail-time] {josk.adapter.db} option required for {josk.adapter.type: "mongo"}` |
| `josk.adapter.type === 'redis' \| 'postgres'` + no `client` | `[mail-time] {josk.adapter.client} option required for {josk.adapter.type: "<type>"}` |

### Errors raised asynchronously by `ready()`

| Trigger | Message |
|---|---|
| Storage `ping()` failed | `[mail-time] [MailTime#ready] can not connect to storage, make sure it is available and properly configured` (with `.cause`) |
| Every transport failed `verify()` | `[mail-time] [MailTime#ready] all <N> transport(s) failed verification — nothing can be delivered` |

## Methods

### `mailTime.sendMail(opts)` → `Promise<string>` (uuid)

Enqueue a letter.

`opts.to` is required (string or non-empty array). At least one of `opts.text` / `opts.html` must be present. All nodemailer fields pass through unchanged (`subject`, `attachments`, `headers`, `cc`, `bcc`, etc.). MailTime-specific options:

| Field | Type | Notes |
|---|---|---|
| `sendAt` | `Date \| number` | Future timestamp. Defaults to "now". |
| `template` | `string` | Overrides constructor `template` for this letter. |
| `concatSubject` | `string` | Overrides constructor `concatSubject` for this letter. Supports `{{count}}` for the folded letter count. |

Throws synchronously:

- `[mail-time] [sendMail] html nor text field is presented` — when both are missing.
- `[mail-time] [sendMail] mailOptions.to is required and must be a string or non-empty Array` — when `to` is invalid.

Returns the email's stable `uuid` string. Use it for cancellation.

### `mailTime.send(opts)`

Alias of `sendMail`.

### `mailTime.cancelMail(uuid)` → `Promise<boolean>`

Cancel a queued letter. Accepts either:

- A string `uuid` returned from `sendMail`.
- A `Promise<string>` (the return value of `sendMail` itself before awaiting).

Returns `true` if the letter was found in an active state and cancelled; `false` if it was already sent / cancelled / unknown. Behavior on `keepHistory`:

- `keepHistory: false` (default) — row is deleted.
- `keepHistory: true` — row is updated to `isCancelled: true`.

### `mailTime.cancel(uuid)`

Alias of `cancelMail`.

### `mailTime.ping()` → `Promise<MailTimePingResult>`

Healthcheck against scheduler + queue. Result shape:

```ts
type MailTimePingResult = {
  status: string;     // 'OK' on success
  code: number;       // 200 on success
  statusCode: number; // same as code
  error?: unknown;    // present on failure
};
```

For `client` instances the scheduler is absent — only the queue is pinged.

### `mailTime.ready()` → `Promise<MailTime>`

Awaits queue & scheduler readiness, then performs a single `ping`. Rejects with:

```
[mail-time] [MailTime#ready] can not connect to storage,
make sure it is available and properly configured
```

…with `.cause` set to the underlying ping error. Call at startup when you want fast failure on misconfigured storage.

### `mailTime.destroy()` → `boolean`

Stops the scheduler timer and the queue-iteration loop. Returns `true` on the first call, `false` afterwards. Always wire to `SIGINT` / `SIGTERM` / `beforeExit` and to test teardown. For graceful shutdown, `await mailTime.drain()` first so in-flight sends complete.

### `mailTime.drain()` → `Promise<void>`

Resolves once every in-flight SMTP send started by the internal pool has settled. The pool is bounded by `concurrency`. Use cases:

- **Graceful shutdown.** `await mailTime.drain(); mailTime.destroy();` lets the current sends finish before exit.
- **Tests that drive iterate.** Calling `await mailTime.___iterate()` or `await mailTime.queue.iterate()` only awaits the scan + claim phase. SMTP work happens in the pool; `await mailTime.drain()` waits for it.

Tests that call `mailTime.___send(task)` directly do **not** need `drain()` — that method runs the full lifecycle synchronously.

### `mailTimePreset(name, overrides?)` → `MailTimeOptions`

Module-level function. Returns a fresh, mutable MailTime constructor config: the named preset is deep-cloned, then `overrides` is deep-merged on top — scalar keys (`retries`, `concurrency`, …) are replaced by the override; nested `josk` keys compose so the caller's `adapter` / `lockOwnerId` / `onError` slot alongside the preset's `zombieTime` / jitter. Throws `Error` on unknown `name` and `TypeError` when `overrides` is provided but is not a plain object.

Built-in `name` values: `'transactional'`, `'otp'`, `'newsletter'`, `'marketing'`, `'notifications'`, `'alerts'`. Full table of what each one sets: `tuning.md` §Presets. Source / values: `presets.js`.

```js
new MailTime(mailTimePreset('otp', {
  prefix: 'otp',
  queue: new RedisQueue({ client }),
  transports: [otpTransport],
  josk: { adapter: { type: 'redis', client } },
}));
```

The raw map is exported as `presets` (read-only); the available names as `presetNames` (read-only array). Use them when you need to introspect a preset's defaults without instantiating MailTime, or compose presets manually.

### `MailTime.Template` static getter/setter

The default HTML envelope template. Read it for inspection (e.g., to extend it); write it to change the per-process default for all instances.

```js
// Use the bundled responsive template
const mailTime = new MailTime({ /* ... */, template: MailTime.Template });

// Replace globally
MailTime.Template = '<html><body>{{{html}}}</body></html>';
```

## Templating

Templates are Mustache-like with two placeholder forms:

- `{{key}}` — string interpolation, **strips any HTML tags from the value**.
- `{{{key}}}` — raw HTML interpolation, no stripping.

Available keys: every property on the passed `opts` (including custom keys like `userName`, `code`, `baseUrl`) plus the standard `subject`, `text`, `html`, `to`. The `template` placeholder applies *after* `text` and `html` are rendered individually, so:

```js
await mailTime.sendMail({
  to: 'user@example.com',
  subject: 'Sign in code',
  userName: 'Mike',
  code: 'A1B2',
  text: 'Hi {{userName}}, code: {{code}}',
  html: '<p>Hi {{userName}}, code: <code>{{code}}</code></p>',
  template: '<body>{{{html}}}</body>',
});
```

Whitespace around the key is allowed: `{{ userName }}` works the same as `{{userName}}`. Keys missing from `opts` are left untouched (`{{missing}}` stays in the output).

## Task object shape (custom adapters)

```ts
type MailTimeRejectedRecipient = { address: string; error: string };

type MailTimeMailOptions = {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  // ...any other nodemailer fields the caller passed (subject, html, text, attachments, headers, …)
  accepted?: string[];                  // lowercased addresses confirmed delivered across all attempts
  rejected?: MailTimeRejectedRecipient[]; // populated only once the task is finalized (isSent + isFailed)
};

type MailTimeTask = {
  uuid: string;
  to?: string | string[];               // root `to` is the concat-dedup key; per-mailOption `to` is the source of truth
  tries: number;
  sendAt: number;                       // ms timestamp
  isSent: boolean;
  isCancelled: boolean;
  isFailed: boolean;
  isSending?: boolean;                  // per-row lock — true while a worker is doing the SMTP roundtrip
  sendingAt?: number;                   // ms timestamp the lock was taken; older than `now - sendingTimeout` means recoverable
  template?: string | false;
  transport: number;                    // index into MailTime.transports
  concatSubject?: string | false;
  mailOptions: MailTimeMailOptions[];   // [0] for single email, [0..N] for concatenated batch
};

type MailTimeIterateOptions = {
  limit?: number;            // when set (e.g. by mode: 'one'), stop after dispatching that many tasks per tick
  sendingTimeout?: number;   // ms; rows whose sendingAt is older than (now - sendingTimeout) are treated as recoverable
};
```

`mailOptions` is always an array — single emails have one entry; concatenated batches have N entries that get folded together by `___compileMailOpts`.

### Per-row lifecycle (`isSending` lock)

- A row is **eligible for claim** when: `isSent=false AND isFailed=false AND isCancelled=false AND sendAt<=now AND tries<maxTries AND (isSending=false OR sendingAt<=now-sendingTimeout)`.
- A row is **claimed atomically** by `queue.update(task, { isSending: true, sendingAt: now, tries: task.tries+1 })`. The storage CAS must reject the update if the predicate above no longer holds — this is what stops two workers (same instance or different cluster nodes) from delivering the same email.
- A row is **released** in one of three ways:
  - **Success** — removed from storage (or `isSent=true, isSending=false, sendingAt=0` when `keepHistory: true`).
  - **Will-retry** — updated to `{ isSending: false, sendingAt: 0, sendAt: now + retryDelay }`.
  - **Final failure** — `isFailed=true, isSending=false, sendingAt=0` (or row deleted when `keepHistory: false`).
- If a worker dies between claim and release, the row stays `isSending=true` until `sendingAt + sendingTimeout` is in the past. The next iterate tick then includes it in the eligibility predicate, and a recovery worker can re-claim it.

### Per-recipient delivery state

When a `to` / `cc` / `bcc` recipient list contains multiple addresses and the SMTP server accepts some but rejects others, MailTime records which addresses got through and retries only the rejected ones on the next attempt:

- `mailOption.to` / `cc` / `bcc` are **never mutated** — they remain the original lists the caller passed.
- `mailOption.accepted` accumulates the lowercased addresses confirmed by `info.accepted` across all attempts. Read it from `onSent(task, info)` to know what actually delivered.
- `mailOption.rejected` is empty until the task finalizes as failed (`isFailed: true`) — typically because the retry budget (`retries` / `maxTries`) is exhausted while one or more recipients still have not been accepted. Each entry is `{ address, error }` with the most recent per-address error string from `info.rejectedErrors`.
- The next attempt's `compiledOpts.to` / `cc` / `bcc` is the original list **minus** addresses already in `accepted` — so previously-delivered recipients do not receive duplicate copies.
- `onSent` fires only once, after the task is fully delivered. `onError` fires only once, after the retry budget is exhausted with at least one un-accepted recipient — its `task.mailOptions[i].rejected` contains the addresses that never made it.
- For nodemailer transports that don't populate `info.accepted` / `info.rejected` (some `sendmail`, JSON or in-memory transports), an empty `accepted` array routes through `onError`'s normal retry path — identical to the pre-existing behavior.

## Exported types

All exported from `mail-time` so TS projects can constrain handlers, custom adapters, and mail option shapes:

```ts
export type MailTimePingResult;
export type MailTimeStorageClient;
export type MailTimeMongoDb;
export type MailTimeTransport;
export type MailTimeJoSkAdapterOptions;
export type MailTimeJoSkOptions;
export type MailTimeTask;
export type MailTimeIterateOptions;
export type MailTimeMailOptions;
export type MailTimeRejectedRecipient;
export type CustomQueue;
export type MailTimeOptions;
```

Internal members prefixed with `__` or `___` are deliberately excluded from the public `.d.ts`. Treat them as private and never depend on them — they may change between minor releases.
