# AGENTS.md

`mail-time` NPM library. Email queue + sender for horizontally scaled Node.js & Bun apps. Synchronizes the queue across processes via Redis / MongoDB / PostgreSQL / custom adapter. Built on top of [`josk`](https://github.com/veliovgroup/josk) for scheduling and task management, and `nodemailer` for email transport management.

## Mission
Send and queue emails in horizontally scaled Node.js and Bun.js. Bulletproof. High perf. Storage agnostic. Two roles: `server` (drains + sends) and `client` (enqueues). Many clients + many servers behind one `prefix`.

## Topology / tuning (read README for use-cases)

### Multiple instances — encouraged
- **One `MailTime` per email class** when policies differ (`otp`, `transactional`, `marketing`, …): own options; **own `prefix` only when purpose/settings differ**.
- **`prefix` same** for all `client` + `server` on one logical queue (app enqueues `prefix: 'otp'`, mail worker drains `prefix: 'otp'`).
- **Never** same `prefix` on two instances with different mail policy (concat, retries, etc.).
- App pods: `type: 'client'`. Mail VM: `type: 'server'` (systemd: one unit per class, e.g. `mailtime@otp`).

### One mail host: 2–8 servers
- Run **2–8 `server` instances** on one machine (~**1 per CPU core**) for **parallel drains across prefixes**, not duplicate drains of same `prefix`.
- Same `prefix` cluster-wide = **one JoSk lease tick** at a time → extra pods ≠ N× throughput, but **do** buy failover/HA (warm standby with a different `lockOwnerId` takes the lease the next tick if the winner dies).
- High volume one queue → **shard prefixes** (`marketing-0`, …), not duplicate instances same `prefix`.

### Throughput levers
| Lever | Effect |
|---|---|
| More `prefix`es / instances | More parallel drain loops |
| `revolvingInterval` ↓, `josk.min/maxRevolvingDelay` ↓ | Faster pickup, more storage I/O |
| Dedicated mail workers | SMTP + tuning isolated from app |
| `concurrency: N` (MailTime) | N parallel SMTPs per server within a single instance |
| `mode: 'one'` (MailTime) | One row claimed per tick — fairness across nodes; storage CAS prevents dupes |
| `josk.concurrency: 1` | No overlapping `iterate` on one process |

### MailTime defaults (override in `opts` / `opts.josk`)
| Knob | Default | Tune |
|---|---|---|
| `mode` | `'batch'` | `'one'` to claim a single row per tick (fairness over throughput) |
| `concurrency` | `1` | N parallel SMTPs per instance. CAS guard on `isSending` prevents double-send. |
| `sendingTimeout` | 300000 (5 min) | Stale-lock recovery. Must exceed slowest legitimate SMTP roundtrip. |
| `revolvingInterval` | 1536 | Latency vs I/O |
| `josk.min/maxRevolvingDelay` | 512 / 2048 | Poll jitter (MailTime overrides JoSk 128/768) |
| `josk.zombieTime` | 60000 | **≥60s**. `___iterate` releases the JoSk lease as soon as scan completes, so zombies are rare unless storage itself stalls. |
| `josk.execute` | `'batch'` | Usually leave; one JoSk uid per instance |
| `josk.concurrency` | `Infinity` | `1` if ticks overlap |
| `josk.lockOwnerId` | random | **Set prod** (`hostname-pid`, pod name) |
| `retries` / `retryDelay` | `60` / `60s` (or `maxTries` 60 if unset) | Per class; OTP short, marketing long |
| `concatEmails` / `concatDelay` | false / 60s | Marketing on; OTP off |

### Per-row lifecycle (`isSending` lock)
1. `___iterate` (the JoSk handler) calls `queue.iterate({ limit, sendingTimeout })`.
2. Per due-and-unclaimed row, the adapter calls `await mailTimeInstance.___dispatch(row)`. `___dispatch` waits for a free pool slot, then starts the full send lifecycle in the background and returns — releasing iterate to move on.
3. The background lifecycle (`___send`) does an atomic CAS: set `isSending=true, sendingAt=now, tries=tries+1` only if `isSent=false AND isFailed=false AND isCancelled=false AND tries=task.tries AND (isSending=false OR sendingAt<=now-sendingTimeout)`. CAS losers drop silently.
4. SMTP runs.
5. On success the row is removed (or `isSent=true, isSending=false, sendingAt=0` with `keepHistory`). On retry, `isSending=false, sendingAt=0, sendAt=now+retryDelay`. On final failure, `isFailed=true, isSending=false`.
6. If a worker dies between step 3 and step 5, the row stays `isSending=true` until `sendingAt + sendingTimeout` elapses — then the iterate predicate makes it eligible again and the CAS allows a new worker to claim it.

### Presets — use `mailTimePreset(name, overrides)`
Recommend `mailTimePreset(name, overrides)` (exported from `mail-time`) before hand-tuning. Names: `transactional`, `otp`, `newsletter`, `marketing`, `notifications`, `alerts`. Each is a partial MailTime config; the function deep-clones and deep-merges overrides (scalars win, `josk` composes). User still supplies `queue` / `transports` / `josk.adapter` / `prefix`. Source: `presets.js`. See README §"Settings presets" for the table.

Non-preset scenarios: Postgres+Postgres for multi-DC; few servers + `josk.concurrency: 1` for rate-limited SMTP; `retries: 0` + `destroy()` for tests; `josk.adapter.resetOnInit: true` dev only.

### Anti-patterns
- Many `server` pods, one `prefix`, expecting N× send rate. (Buys failover/HA, not throughput — shard prefixes or raise `concurrency` for throughput.)
- `zombieTime` < worst `iterate` (slow SMTP × many due rows).
- `resetOnInit` / `autoClear` in prod without intent.
- Replica reads for queue or scheduler.

## Structure
- `index.js` — core ESM. **Edit this**.
- `index.cjs` — generated via Rollup on `prepublishOnly`. CJS bundle for `require`. Never edit directly.
- `presets.js` — built-in MailTime presets (`mailTimePreset`, `presets`, `presetNames`). Edit here when adding / tuning presets; re-export already lives in `index.js`.
- `helpers.js` — shared helpers (`debug`, `logError`, `isPlainObject`, `deepMerge`, `equals`).
- `adapters/{mongo,redis,postgres,blank-example}.js` — queue adapter implementations. `blank-example.js` is the scaffold for custom adapters.
- `*.d.ts` / `*.d.cts` — generated from JSDoc on `prepublishOnly`. Internal `__` / `___` members are stripped by `scripts/strip-internal-dts.mjs`. **Never edit manually.**
- `scripts/strip-internal-dts.mjs` — post-processor that removes private members from generated .d.ts files.
- `test/` — Jest unit tests (`test/jest/*.test.js`) + Mocha integration tests against real DBs (`test/npm-*.js`) + TS declaration tests (`test/types/*.{ts,cts}`).
- `skills/mail-time/SKILL.md` + `skills/mail-time/references/` — distributable Claude Code skill (`npx skills` layout).
- `docs/queue-api.md` — custom queue contract.

## Code Style
- 2-space indentation. Single quotes. Semicolons.
- **Prefer simple ES classes** for cohesive state/services when they clarify lifecycle (e.g. a small data service with start/stop).
- Public methods get JSDoc. Internal helpers prefixed with `__` or `___`.
- Use **small pure functions** for transforms, formatting, and validation.
- Prefer O(n) single-pass loops; cache derived values.
- Prefer `void 0` to `undefined` where applicable.
- Prefer arrow functions assigned to `const` over named `function`.

### JS Style Example

```js
const string = 'string value';
const object = {
  key: string,
};

const complexObject = {
  key: string,
  array: ['one', 'two', 'three'],
  date: new Date(),
  timestamp: Date.now(),
  arrayWithObjects: [{
    key: {
      keyLevel2: false,
    },
    key2: {
      array: [{
        keyLevel3: true,
      }]
    }
  }, {
    keySecondObject: {
      keyLevel2: true,
      otherKeyLevel2: 'string - lorem ipsium',
    }
  }],
};

const sayName = (name) => {
  if (!name) {
    return void 0;
  }

  return `Your name is ${name}`;
};
```

## Standards
- Terse. No obvious comments. Exact adapter API compliance.
- ESM primary; JSDoc on public API; CJS generated. Node ≥ 20.9.0, Bun ≥ 1.1.0.
- JSDoc on source drives `.d.ts`. Mark internal methods with the `___`/`__` prefix; they get stripped.
- Strict validation in constructors. Throw with `[mail-time] [<scope>]` prefix.
- One runtime dep: `josk`. **Don't add deps** without strong reason — the package's selling points are "tiny, no fluff".
- Update: README (examples/prereqs), all .d.ts, tests, CHANGELOG.md, package version on change.
- Never edit `index.cjs` or any `.d.ts`. Always edit source, regenerate before publish.
- Follow terse response rule: drop articles/fillers. [subject] [verb] [reason]. [next].


## Testing

This package ships with tests tailored to Node.js, Bun.js, and Meteor.js.

### NPM tests
```sh
npm install
REDIS_URL=redis://127.0.0.1:6379 MONGO_URL=mongodb://127.0.0.1:27017/test PG_URL=postgres://127.0.0.1:5432/postgres npm test
```

### Bun tests
```sh
bun install
REDIS_URL=redis://127.0.0.1:6379 MONGO_URL=mongodb://127.0.0.1:27017/test PG_URL=postgres://127.0.0.1:5432/postgres bun test
```

### Meteor tests
```sh
meteor npm install
REDIS_URL=redis://127.0.0.1:6379 MONGO_URL=mongodb://127.0.0.1:27017/test PG_URL=postgres://127.0.0.1:5432/postgres meteor test-packages ./ --driver-package=meteortesting:mocha
```

- Jest threshold: 85% statements/branches/functions/lines. Don't drop it.
- Add tests for any change. Cover both happy path and at least one failure path.
- Bun: `bun test ./test/jest` runs the Jest suite under Bun's runner.
- Live-SMTP recipient for integration tests: use `{random}@md5hashing.net` (the domain accepts every inbound recipient). For a guaranteed reject use `${randomUUID()}@${randomUUID()}.invalid`.

## Guidelines
- Read `docs/queue-api.md` + existing adapters + tests before touching `adapters/`.
- New adapter: copy `adapters/blank-example.js`, add an entry to `README.md` storage matrix, write Jest unit tests, regenerate types.
- Bug fix: reproduce in a Jest test, fix, leave the regression test in place.
- Feature: update tests first, then code, then docs. The interface is in JSDoc on `index.js` — the .d.ts is downstream.
- JoSk knobs (`zombieTime`, `execute`, `concurrency`, `lockOwnerId`, `onError`) are pass-through except MailTime sets `minRevolvingDelay` 512, `maxRevolvingDelay` 2048, `zombieTime` 60000, `execute` `'batch'` when unset. Document non-passthrough in README/CHANGELOG.
- Custom queue's `update` must atomically guard the send claim on `{ isSending: true, tries: Number }` updates. The predicate is `isSent=false AND isFailed=false AND isCancelled=false AND tries=email.tries AND (isSending=false OR sendingAt <= now - sendingTimeout)`. Returning `true` from a stale claim causes duplicate sends.
- Custom queue's `iterate(opts)` must honor `opts.limit` (stop after that many dispatches per tick) and `opts.sendingTimeout` (treat rows where `sendingAt <= now - opts.sendingTimeout` as eligible even when `isSending=true`). Adapters dispatch each due row via `await this.mailTimeInstance.___dispatch(row)` — not `___send` directly.

## Edit rules and flow
- Make the change. Run Jest. Run TS checks.
- If JSDoc on `index.js` or any adapter changed: `npm run prepublishOnly` to refresh `index.cjs` + all `.d.ts` / `.d.cts`.
- For major API changes add a migration note to `CHANGELOG.md`.

Update this AGENTS.md on major refactors.
