import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = mkdtempSync(join(tmpdir(), 'mailtime-meteor-types-'));
const meteor = (...args) => execFileSync('meteor', args, { cwd: app, stdio: 'inherit' });

try {
  meteor('create', '--bare', app);
  mkdirSync(join(app, 'packages'), { recursive: true });
  symlinkSync(root, join(app, 'packages', 'mailtime'), 'dir');
  copyFileSync(join(root, 'test/meteor-types/tsconfig.json'), join(app, 'tsconfig.json'));
  meteor('add', 'ostrio:mailer', 'zodern:types');
  try {
    meteor('lint');
  } catch {
    // zodern:types exits `meteor lint` early once types are generated; the
    // generated file below is the real assertion.
  }
  if (!existsSync(join(app, '.meteor/local/types/packages.d.ts'))) {
    throw new Error('[mail-time] Meteor did not generate package type declarations');
  }
  mkdirSync(join(app, 'server'));
  copyFileSync(join(root, 'test/meteor-types/consumer.ts'), join(app, 'server/consumer.ts'));
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(app, 'tsconfig.json')], { cwd: app, stdio: 'inherit' });
} finally {
  rmSync(app, { recursive: true, force: true });
}
