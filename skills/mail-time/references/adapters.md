# MailTime queue adapters

Three built-in queue adapters plus the contract for writing custom ones. Pick by topology and existing infra.

## Quick comparison

| Adapter | Best for | Prerequisite NPM | Server requirement | Atomic claim |
|---|---|---|---|---|
| `PostgresQueue` | Multi-DC, mixed clocks, strict exactly-once. | `pg` | `postgres ≥ 12` | `UPDATE … WHERE tries = $task.tries` (predicate guard) |
| `RedisQueue` | High-throughput single-region, sub-second polling. | `redis@^4 \|\| ^5` | `redis-server ≥ 5.0.0` | `WATCH` + `MULTI` |
| `MongoQueue` | Apps already running Mongo (especially Meteor.js). | `mongodb` (official) | `mongod ≥ 4.0.0` | `updateOne` with predicate guard |

All adapters expose the same seven-method interface (`ping`, `iterate`, `getPendingTo`, `push`, `cancel`, `remove`, `update`) plus an optional `ready` that resolves once startup migrations / indexes are in place.

## `PostgresQueue`

```js
import { MailTime, PostgresQueue } from 'mail-time';
import { Pool } from 'pg';

const pgPool = new Pool({ connectionString: process.env.PG_URL });

const mailQueue = new MailTime({
  type: 'server',
  queue: new PostgresQueue({ client: pgPool }),
  josk: {
    adapter: { type: 'postgres', client: pgPool },
    lockOwnerId: 'mail-service-1',
  },
  transports: [/* ... */],
  from: (transport) => `"App" <${transport.options.from}>`,
});
await mailQueue.ready();
```

### Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `client` | `pg.Pool \| pg.Client` | — | **Required.** Any object exposing `.query(text, values?) => Promise<{ rowCount, rows }>`. `pg.Pool` is recommended for long-running apps. |
| `prefix` | `string` | `'default'` | Scopes rows in `mail_time_queue.prefix`. |

### Table layout

PostgresQueue auto-creates one table on first `ready()` (idempotent):

- `mail_time_queue` — composite uniqueness `(prefix, uuid)`. Indexes:
  - `idx_mail_time_queue_prefix_uuid` — unique, for fast lookup / upsert.
  - `idx_mail_time_queue_due` — covers the iterate path (`prefix, is_sent, is_failed, is_cancelled, send_at, tries`).
  - `idx_mail_time_queue_pending_to` — covers `getPendingTo` (`prefix, to_address, is_sent, is_failed, is_cancelled, send_at`).

The setup acquires a two-key, per-prefix advisory lock — `pg_advisory_lock(0x4D61696C, <int32 hash of prefix>)` — so concurrent processes don't race on `CREATE TABLE`, and co-tenant queues with distinct prefixes don't serialize each other's setup.

### Guidelines

- Use `pg.Pool`. Share with the app if pool capacity allows; use a dedicated pool for the mail micro-service pattern.
- One writable primary endpoint. No replica reads — task claims must be visible immediately.
- The claim predicate (`tries = $task.tries`) is `SERIALIZABLE`-safe under default `READ COMMITTED`. No need to bump the isolation level.

## `RedisQueue`

```js
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';

const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();

const mailQueue = new MailTime({
  type: 'server',
  queue: new RedisQueue({ client: redisClient }),
  josk: {
    adapter: { type: 'redis', client: redisClient },
  },
  transports: [/* ... */],
});
```

### Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `client` | `RedisClient` | — | **Required.** Already-connected `redis@^4` or `redis@^5` client (`RedisClientType` or `RedisClusterType`) with `watch()` and `multi()`. |
| `prefix` | `string` | `'default'` | Scopes keys under `mailtime:<prefix>:…`. |

### Keys (for `prefix: 'default'`)

- `mailtime:default:letter:<uuid>` — JSON of the email task.
- `mailtime:default:sendat:<uuid>` — `sendAt` timestamp, scanned by `iterate`.
- `mailtime:default:concatletter:<to>` — uuid pointer for concat dedup. Has `PXAT` TTL.

### Topology guidelines

- One writable primary endpoint, or a Redis Cluster endpoint where the prefix maps to one hash slot via hash-tagged prefixes.
- **Do not** route reads to replicas. Lease writes must be immediately visible.
- **Do not** use Redis active-active / multi-master or KeyDB active-replication. Conflict resolution can allow duplicate claims across writers.
- The `push` path uses `MULTI` when the client supports it, falling back to three sequential `SET`s otherwise.
- The send-claim path requires `WATCH` + `MULTI` for atomic compare-and-set. Minimal clients without those methods cannot safely claim rows.

## `MongoQueue`

```js
import { MailTime, MongoQueue } from 'mail-time';
import { MongoClient } from 'mongodb';

const db = (await MongoClient.connect(process.env.MONGO_URL)).db('mailtime');

const mailQueue = new MailTime({
  type: 'server',
  queue: new MongoQueue({ db }),
  josk: {
    adapter: { type: 'mongo', db },
  },
  transports: [/* ... */],
});
```

### Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `db` | `Db` | — | **Required.** Mongo `Db` from the official `mongodb` driver. |
| `prefix` | `string` | `''` | Appended to collection name: `__mailTimeQueue__<prefix>`. |

### Collections + indexes

On `ready()`, `MongoQueue` ensures three indexes (creates or drops+recreates if shape mismatches):

- `{ uuid: 1 }` — fast lookup.
- `{ isSent: 1, isFailed: 1, isCancelled: 1, to: 1, sendAt: 1 }` — `getPendingTo`.
- `{ isSent: 1, isFailed: 1, isCancelled: 1, sendAt: 1, tries: 1 }` — `iterate`.

Index conflict (Mongo error code 85) is handled by dropping the legacy index and recreating with the new shape.

### Recommended connection options (replica set)

```js
const client = await MongoClient.connect(process.env.MONGO_URL, {
  writeConcern: { j: true, w: 'majority', wtimeout: 30000 },
  readConcern: { level: 'majority' },
  readPreference: 'primary',
});
```

### "Tested only against the official driver"

`MongoQueue` (and JoSk's `MongoAdapter`) are verified against the official `mongodb` NPM package. CosmosDB, DocumentDB, Mongoose's wrapped client, and other Mongo-compatible stores are not tested. Flag this when recommending MailTime for those backends.

## Prefix mapping at a glance

`prefix` isolates one MailTime instance's storage from another in the same store. Same prefix = same shared queue; different prefix = isolated namespace.

| Adapter | Storage layout (for `prefix: 'app'`) |
|---|---|
| Postgres | Rows in `mail_time_queue` filtered by `prefix='app'`. Scheduler row in `josk_locks` with `lock_key='josk-mailTimeQueueapp.lock'`. |
| Redis | Keys `mailtime:app:letter:*`, `mailtime:app:sendat:*`, `mailtime:app:concatletter:*`. Scheduler keys `josk:{mailTimeQueueapp}:…`. |
| Mongo | Collection `__mailTimeQueue__app`. Scheduler collection `__JobTasks__mailTimeQueueapp`; shared lock collection `__JobTasks__.lock`. |

Use distinct prefixes for tenants, environments, transactional vs marketing queues, etc.

## Cleanup recipes (dev / test)

### Postgres

```sql
DELETE FROM mail_time_queue WHERE prefix = 'default';
DELETE FROM josk_tasks WHERE prefix = 'mailTimeQueuedefault';
DELETE FROM josk_locks WHERE lock_key = 'josk-mailTimeQueuedefault.lock';
```

### Redis

```sh
redis-cli --no-auth-warning --scan --pattern "mailtime:default:*" \
  | xargs redis-cli --no-auth-warning DEL
redis-cli --no-auth-warning --scan --pattern "josk:{mailTimeQueuedefault}:*" \
  | xargs redis-cli --no-auth-warning DEL
```

### Mongo

```js
await db.collection('__mailTimeQueue__default').deleteMany({});
await db.collection('__JobTasks__mailTimeQueuedefault').deleteMany({});
await db.collection('__JobTasks__.lock').deleteMany({
  uniqueName: '__JobTasks__mailTimeQueuedefault',
});
```

## Custom adapter

Custom queues implement the `CustomQueue` interface and follow the design rules tied to correctness.

### Interface

```ts
interface CustomQueue {
  ping(): Promise<MailTimePingResult>;
  iterate(opts?: MailTimeIterateOptions): Promise<void> | void;
  getPendingTo(to: string, sendAt: number): Promise<MailTimeTask | object | null>;
  push(email: MailTimeTask): Promise<void> | void;
  cancel(uuid: string): Promise<boolean>;
  remove(email: MailTimeTask | object): Promise<boolean>;
  update(email: MailTimeTask | object, updateObj: object): Promise<boolean>;
  ready?(): Promise<void>;            // optional init barrier
  mailTimeInstance?: MailTime;        // set automatically when MailTime constructs
}

type MailTimeIterateOptions = {
  limit?: number;            // set by mode: 'one' (sends 1) or mode: 'batch' (no limit)
  sendingTimeout?: number;   // ms — rows with sendingAt <= now - sendingTimeout are recoverable
};
```

Start from `adapters/blank-example.js` in the source tree — it is the canonical scaffold.

### Required design rules

- **Atomic claim in `update`.** When the update object is `{ isSending: true, sendingAt: <ms>, tries: <N> }`, MailTime is claiming the email for sending. The update **must** be atomic and conditional on **all** of:
  - `isSent === false`
  - `isFailed === false`
  - `isCancelled === false`
  - stored `tries === task.tries` (the caller's snapshot — **not** `tries < maxTries`. The snapshot match is the compare-and-set: two workers each loaded the row at `tries=N`, but only one can write `tries=N+1` back. Using `<` lets both succeed and you double-send.)
  - stored `isSending === false` **OR** stored `sendingAt <= updateObj.sendingAt - sendingTimeout` (stale-lock recovery)
  Return `false` whenever the predicate fails, so parallel workers (in this process or another node) drop the row and JoSk picks something else up next tick. Return `true` only when the storage layer atomically flipped `isSending` to `true`.
- **`iterate(opts)` calls `await mailTimeInstance.___dispatch(task)`** — *not* `___send` — for every row matching: `isSent === false && isFailed === false && isCancelled === false && sendAt <= Date.now() && tries < maxTries && (isSending === false || sendingAt <= Date.now() - opts.sendingTimeout)`. `___dispatch` acquires a slot from MailTime's bounded send pool (the `concurrency` option) and starts the full send lifecycle detached. Stop the scan after `opts.limit` dispatches when `opts.limit` is set (MailTime sends `1` when configured with `mode: 'one'`).
- **Persist `isSending` and `sendingAt`** alongside the other fields in `push`. New rows start with `isSending: false, sendingAt: 0`.
- **Honor `mailTimeInstance.keepHistory`** in `cancel`. When `false`, delete the row; when `true`, mark `isCancelled: true`.
- **`getPendingTo`** returns at most one active task addressed to `to` with `sendAt <= passed-sendAt`, `isSending === false`, and `tries < maxTries`. Used by `concatEmails`.
- **`ready()`** is optional but recommended if the storage needs migrations / indexes.

### Task object shape (what to pass to `___dispatch`)

See `references/api.md` § Task object shape. The minimum fields used by the send lifecycle: `uuid`, `tries`, `sendAt`, `isSent`, `isCancelled`, `isFailed`, `isSending`, `sendingAt`, `template`, `transport`, `mailOptions`, `concatSubject`.

### Recommended adapter flow

1. `iterate(opts)` opens a cursor / scan / SQL select for due rows that match the iterate predicate above.
2. For each row, call `await this.mailTimeInstance.___dispatch(task)`. The `await` waits only for the send pool to acquire a slot — not for the SMTP roundtrip. Once the slot is acquired, MailTime starts the send in the background and `___dispatch` resolves, letting your scan move to the next due row.
3. The send lifecycle (`___send`, internal) calls `this.update(task, { isSending: true, sendingAt: now, tries: N })` first — the atomic claim. If `update` returns `false`, another worker won the race and the lifecycle bails out cleanly.
4. The lifecycle invokes the SMTP transport. On success, it calls `this.remove(task)` when `keepHistory: false`, or `this.update(task, { isSent: true, isSending: false, sendingAt: 0, mailOptions: … })` when `keepHistory: true`. Will-retry releases the lock via `this.update(task, { isSending: false, sendingAt: 0, sendAt: nextSendAt, … })`. Final failure mirrors the success branch with `isFailed: true`.
5. When a worker dies between step 3 and the release, the row stays `isSending: true` until `sendingAt + sendingTimeout` is in the past. The next iterate cycle then re-includes it in the eligibility predicate, and a recovery worker can re-claim it.

The atomic per-row claim is what prevents two workers — same instance or different cluster nodes — from sending the same email. A global queue-level lock is **not** enough, and MailTime's own pool relies on this same CAS to safely run `concurrency > 1`.
