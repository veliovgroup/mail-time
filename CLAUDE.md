# CLAUDE.md

This file is Claude Code's working brief for the `mail-time` repository. It complements `AGENTS.md` (general agent guidelines) and `skills/mail-time/SKILL.md` (the distributable user-facing skill).

## What this repo is

`mail-time` is an NPM package that queues and sends emails (via `nodemailer` transports) across horizontally scaled Node.js / Bun apps. It uses Mongo / Redis / Postgres (or a custom adapter) for queue storage and the [`josk`](https://github.com/veliovgroup/josk) library for cluster-aware scheduling.

## Where to look first

- **Editing core behavior?** → `index.js`. Everything else (CJS bundle, types) is regenerated from it.
- **Adding / fixing an adapter?** → `adapters/<store>.js` plus `adapters/blank-example.js` as scaffold + `docs/queue-api.md` for the contract.
- **Tuning a preset / adding one?** → `presets.js`. Test in `test/jest/presets.test.js`. The re-export from `index.js` is already wired.
- **Testing?** → `test/jest/*.test.js` is the fast unit suite (no live DB). `test/npm-*.js` is the integration suite that needs `REDIS_URL` / `MONGO_URL` / `PG_URL`.
- **TS types?** → JSDoc lives in `index.js`, `presets.js`, and `adapters/*.js`. The .d.ts is generated. To strip private members, `scripts/strip-internal-dts.mjs` runs as part of `prepublishOnly`.
- **User docs?** → `README.md` (public) and `skill/SKILL.md` (Claude-facing).
- **AI instructions and guidelines?** → `AGENTS.md` and this file `CLAUDE.md` (Claude-facing).

## Mental model for changes

1. Read the JoSk skill (`/josk` or `~/.claude/skills/josk/`) when changing scheduler-related code. MailTime is a thin layer over JoSk for an email-shaped workload — most "should this happen?" questions resolve through JoSk's contract.
2. Public methods on `MailTime` and the three queues are stable contract. Internal helpers (`___send`, `___compileMailOpts`, `__getKey`, etc.) are explicitly marked internal and stripped from .d.ts — they're free to change.
3. The only runtime dep is `josk`. Don't add another without a written reason in the PR description.

## Common pitfalls to avoid

- **Adding a "convenience" dep**: explicit no-go. We removed `deepmerge` to get to a single runtime dep.
- **Editing `index.cjs`, `index.d.ts`, `index.d.cts`, or `adapters/*.d.ts` directly**: they're generated. Run `npm run prepublishOnly` to refresh.
- **Lowering Jest coverage threshold**: don't. Add tests instead.
- **Bypassing the atomic claim guard in a queue adapter's `update`**: this is what prevents two servers from sending the same email. Claim updates carry `updateObj = { isSending: true, sendingAt: <ms>, tries: N }`. The guard predicate is `isSent=false AND isFailed=false AND isCancelled=false AND tries=task.tries AND (isSending=false OR sendingAt <= now - sendingTimeout)`. `isSending` is the per-row lock; `sendingAt` is when it was taken (for stale-lock recovery).
- **Routing iterate dispatches through `___send` instead of `___dispatch`**: adapters must call `await mailTimeInstance.___dispatch(row)` for each due row. `___dispatch` acquires a slot from the bounded send pool (`concurrency` option) and starts `___send` detached so the JoSk lease can be released as soon as the scan completes.
- **Setting `zombieTime` below 60s**: SMTP send + retries can legitimately take ~30s. JoSk's docs explicitly call this out. Because `___iterate` returns as soon as the scan completes (not after SMTP), only a stuck storage scan can blow `zombieTime`.
- **Setting `sendingTimeout` below the worst-case SMTP roundtrip**: a healthy still-mid-SMTP worker can lose its `isSending` lock to a "recovery" worker, causing a duplicate send. Keep `sendingTimeout` strictly above worst-case roundtrip.
- **Skipping `mailTime.destroy()` (or `await mailTime.drain()`) in tests**: the scheduler timer keeps the test process alive. Tests that await `___send` directly still run the full lifecycle synchronously, but tests that drive iterate (via `___iterate` or `queue.iterate()`) must call `await mailTime.drain()` to let the in-process send pool finish.

## Local commands

```sh
# Jest unit suite (no live DB needed)
npm run test:jest

# Type-checks the .d.ts against fixture .ts/.cts files
npm run test:types

# Mocha integration suite (needs all three DBs)
REDIS_URL=... MONGO_URL=... PG_URL=... npm run test:mocha

# Bun runner (Jest-shape tests only)
bun test ./test/jest

# Refresh .cjs + .d.ts after editing index.js or adapters
npm run prepublishOnly
```

## When working on the skill

`skills/mail-time/SKILL.md` is the distributable Claude-facing knowledge bundle. The layout follows the `npx skills` convention: a top-level `skills/` directory with each skill in its own subfolder. Keep `SKILL.md` under ~500 lines; push deep detail into `skills/mail-time/references/{api,adapters,recipes,tuning}.md`. The frontmatter `description` is the trigger — it should be specific enough that Claude reaches for the skill *without* the user naming MailTime explicitly. When user-visible API changes, update both `README.md` and `skills/mail-time/references/api.md` so the skill stays accurate.
