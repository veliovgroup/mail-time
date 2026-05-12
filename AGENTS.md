# AGENTS.md

`mail-time` NPM library. Manages and distributes sending emails within scaled apps (clusters, multi-server, multi-DC). Syncs email queue via Redis/Mongo/Postgres/custom adapter. Built on top of `josk` NPM library.

## Mission
Send and queue emails in horizontally scaled Node.js. Bulletproof. High perf. Storage agnostic. Easy adapters. Two modes as "server" and "client" with option to have multiple servers and clients in a cluster.

## Structure
- `index.js`: core ESM (MailTime + adapters). Edit this.
- `index.cjs`: generated via `prepublishOnly: rollup index.js --file index.cjs --format cjs` (npm publish runs it). CJS bundle for "require". Never edit directly. Regenerate before publish.
- `adapters/`: postgres.js (pg Pool/tables/indexes/locks), mongo.js, redis.js, blank-example.js + .d.ts. Implement Adapter.
- `test/`: npm-*.js (mocha+chai), meteor.js.
- `*.d.ts`: Generated from JSDoc in `index.js` + adapters via `tsc --emitDeclarationOnly` on `prepublishOnly`. Do not edit manually.
- `docs/queue-api.md`: full queue adapter contract.
- README.md, CHANGELOG.md, package.json (exports map, types, prepublishOnly now includes tsc).

## Code Style
- **Indentation:** 2 spaces.
- Use **single quotes** for strings.
- **Prefer simple ES classes** for cohesive state/services when they clarify lifecycle (e.g. a small data service with start/stop).
- Use **small pure functions** for transforms, formatting, and validation.
- **Performance**: favor O(n) single passes, avoid repeated work and heavy loops, cache derived values when dependencies are narrow.
- Always end line with semicolon `;`.
- Prefer `void 0` to `undefined` where applicable, like `return void 0`.
- Prefer functions defined as variable to "named functions" where applicable.

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
- ESM primary. JSDoc on public API.
- Strict validation in ctors. Throw on missing adapter/client/db.
- Private: __ prefix. Use joskInstance.__errorHandler, __execute.
- Terse. No obvious comments. Exact adapter API compliance.
- Update: README (examples/prereqs), all .d.ts, tests, CHANGELOG.md, package version on change.
- Errors: onError hook preferred over throw. ready() or returned Promise controls completion.
- TS: JSDoc in source drives declarations. Adapter required in JoSkOption. Run `npm run prepublishOnly` after changes to `index.js`/adapters.
- Never edit `index.cjs` or any `.d.ts`. Always edit source, regenerate before publish.
- Follow terse response rule: drop articles/fillers. [subject] [verb] [reason]. [next].

## Testing
```sh
# Full (Redis+Mongo+PG)
npm install --save-dev
# DEFAULT RUN
REDIS_URL=redis://127.0.0.1:6379 MONGO_URL=mongodb://127.0.0.1:27017/test PG_URL=postgres://... npm test
```

- Requires running DBs.
- Add test for any change. Target 99%+.

## Guidelines
- Read queue-api.md + existing adapters + tests before edit.
- New adapter: copy blank-example, add .d.ts, test/*.js, update README/index.js/TS/CHANGELOG.
- Bug: reproduce in test. Fix + regression test.
- Feature: update docs/TS/tests first. Maintain 2s min interval, jitter note.
- PR: full test suite, lint clean, update CHANGELOG.
- Use MongoDB skills only on query/index/schema. PG similar. Frontend skill never. Always read files first.

## Edit rules and flow
- Introduce changes, validate, run tests.
- Update TS definitions if absolutely necessary after introduced changes.
- Update documentation if necessary adding new features or changing old ones.
- In case of major updates — Add migration instructions to package documentation.

Update this AGENTS.md on major refactors.
