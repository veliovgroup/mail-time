# AGENTS.md

`mail-time` NPM library. Email queue + sender for horizontally scaled Node.js & Bun apps. Synchronizes the queue across processes via Redis / MongoDB / PostgreSQL / custom adapter. Built on top of [`josk`](https://github.com/veliovgroup/josk).

## Mission
Send and queue emails in horizontally scaled Node.js. Bulletproof. High perf. Storage agnostic. Two roles: `server` (drains + sends) and `client` (enqueues). Many clients + many servers behind one `prefix`.

## Structure
- `index.js` — core ESM. **Edit this**.
- `index.cjs` — generated via Rollup on `prepublishOnly`. CJS bundle for `require`. Never edit directly.
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

## Guidelines
- Read `docs/queue-api.md` + existing adapters + tests before touching `adapters/`.
- New adapter: copy `adapters/blank-example.js`, add an entry to `README.md` storage matrix, write Jest unit tests, regenerate types.
- Bug fix: reproduce in a Jest test, fix, leave the regression test in place.
- Feature: update tests first, then code, then docs. The interface is in JSDoc on `index.js` — the .d.ts is downstream.
- JoSk knobs (`zombieTime`, `execute`, `concurrency`, `lockOwnerId`, `onError`) are pass-through. Don't override JoSk defaults silently — document any non-passthrough.
- Custom queue's `update` must atomically guard the send claim. Returning `true` from a stale claim causes duplicate sends.

## Edit rules and flow
- Make the change. Run Jest. Run TS checks.
- If JSDoc on `index.js` or any adapter changed: `npm run prepublishOnly` to refresh `index.cjs` + all `.d.ts` / `.d.cts`.
- For major API changes add a migration note to `CHANGELOG.md`.

Update this AGENTS.md on major refactors.
