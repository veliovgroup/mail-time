import { describe, expect, it } from '@jest/globals';
import { parse } from 'acorn';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Shipped runtime files must parse as ES2020: the npm build still loads on Node 14.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeFiles = [
  'index.js',
  'index.cjs',
  'helpers.js',
  'presets.js',
  ...readdirSync(root).filter((name) => /^recipient-.*\.js$/.test(name)),
  ...readdirSync(join(root, 'adapters')).filter((name) => name.endsWith('.js')).map((name) => `adapters/${name}`),
];

describe('shipped runtime files parse as ES2020', () => {
  it.each(runtimeFiles)('%s', (file) => {
    const source = readFileSync(join(root, file), 'utf8');
    const sourceType = file.endsWith('.cjs') ? 'script' : 'module';
    expect(() => parse(source, { ecmaVersion: 2020, sourceType })).not.toThrow();
  });

  it('rejects logical assignment', () => {
    expect(() => parse('let a; a ??= 1;', { ecmaVersion: 2020 })).toThrow();
  });
});
