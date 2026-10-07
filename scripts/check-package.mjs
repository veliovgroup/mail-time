#!/usr/bin/env node
// Packs the repo, installs the tarball into a scratch project and verifies what a consumer
// sees: ESM and CJS entry points, every subpath under both conditions, export identity, and
// TypeScript resolution of the subpaths from a package without "type": "module".
// Usage: node scripts/check-package.mjs   (run from the repo root; needs network for josk)
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const repo = resolve(new URL('..', import.meta.url).pathname);
const work = mkdtempSync(join(tmpdir(), 'mail-time-pack-'));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: work, stdio: 'pipe', encoding: 'utf8', ...opts });
const fail = (msg) => { console.error(`[check-package] FAIL ${msg}`); process.exitCode = 1; };

try {
  run('npm', ['pack', '--pack-destination', work, '--silent'], { cwd: repo });
  const tarball = readdirSync(work).find((f) => /^mail-time-.*\.tgz$/.test(f));
  if (!tarball) throw new Error('npm pack produced no tarball');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'consumer', private: true, dependencies: { 'mail-time': `file:${tarball}` } }));
  run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--silent']);

  const subpaths = ['presets', 'adapters/mongo', 'adapters/redis', 'adapters/postgres'];
  writeFileSync(join(work, 'probe.cjs'), `
    const main = require('mail-time');
    const expectFns = ['MailTime', 'MongoQueue', 'RedisQueue', 'PostgresQueue', 'mailTimePreset'];
    for (const k of expectFns) if (typeof main[k] !== 'function') throw new Error('cjs main missing ' + k);
    for (const sub of ${JSON.stringify(subpaths)}) {
      const m = require('mail-time/' + sub);
      for (const k of Object.keys(m)) if (m[k] !== main[k]) throw new Error('cjs ' + sub + ' export ' + k + ' differs from main');
    }
    console.log('cjs ok');
  `);
  writeFileSync(join(work, 'probe.mjs'), `
    import * as main from 'mail-time';
    const expectFns = ['MailTime', 'MongoQueue', 'RedisQueue', 'PostgresQueue', 'mailTimePreset'];
    for (const k of expectFns) if (typeof main[k] !== 'function') throw new Error('esm main missing ' + k);
    for (const sub of ${JSON.stringify(subpaths)}) {
      const m = await import('mail-time/' + sub);
      for (const k of Object.keys(m)) if (m[k] !== main[k]) throw new Error('esm ' + sub + ' export ' + k + ' differs from main');
    }
    if (typeof main.mailTimePreset('otp') !== 'object') throw new Error('mailTimePreset(otp) is not an object');
    console.log('esm ok');
  `);
  for (const [bin, label] of [[process.execPath, 'node'], ['bun', 'bun']]) {
    for (const probe of ['probe.cjs', 'probe.mjs']) {
      const res = spawnSync(bin, [probe], { cwd: work, encoding: 'utf8' });
      if (res.error?.code === 'ENOENT') { console.log(`[check-package] skip ${label} (not installed)`); break; }
      if (res.status !== 0) fail(`${label} ${probe}: ${res.stderr || res.stdout}`);
      else console.log(`[check-package] ${label} ${probe}: ${res.stdout.trim()}`);
    }
  }

  // A CommonJS-typed consumer (no "type": "module") must resolve the subpaths through the require condition.
  writeFileSync(join(work, 'consumer.ts'), `
    import { mailTimePreset } from 'mail-time/presets';
    import { RedisQueue } from 'mail-time/adapters/redis';
    import { MongoQueue } from 'mail-time/adapters/mongo';
    import { PostgresQueue } from 'mail-time/adapters/postgres';
    import type { MailTimeErrorDetails, MailTimeDrainResult } from 'mail-time';
    const d: MailTimeDrainResult = { failedWrites: 0 };
    const e: MailTimeErrorDetails = { phase: 'verify', transportIndex: 0 };
    void d; void e; void mailTimePreset; void RedisQueue; void MongoQueue; void PostgresQueue;
  `);
  writeFileSync(join(work, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: [] }, files: ['consumer.ts'] }));
  const tsc = spawnSync(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], { cwd: work, encoding: 'utf8' });
  if (tsc.status !== 0) fail(`tsc (CJS consumer):\n${tsc.stdout}${tsc.stderr}`);
  else console.log('[check-package] tsc CJS-typed consumer ok');
} catch (error) {
  fail(error.stack || String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (!process.exitCode) console.log('[check-package] PASS');
