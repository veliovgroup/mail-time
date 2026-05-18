#!/usr/bin/env node

/**
 * Strip `__` and `___` prefixed members from generated `.d.ts` files.
 * TypeScript's `stripInternal` is unreliable for JSDoc in `allowJs` mode,
 * so this script enforces the convention manually.
 *
 * Removes:
 *   - JSDoc blocks immediately preceding a `__name` or `___name` member
 *   - The member declaration including any multi-line type signature
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { argv } from 'node:process';

const files = argv.slice(2);
if (files.length === 0) {
  console.error('Usage: strip-internal-dts.mjs <file.d.ts> [...]');
  process.exit(2);
}

const pruneDocBlock = (out) => {
  while (out.length && out[out.length - 1].trim() === '') {
    out.pop();
  }
  if (out.length === 0 || !out[out.length - 1].includes('*/')) {
    return;
  }
  while (out.length) {
    const popped = out.pop();
    if (popped.includes('/**')) {
      break;
    }
  }
};

const skipMember = (lines, start) => {
  let depth = 0;
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    // Don't count `>` in `=>` arrows as a closing angle bracket.
    const stripped = raw.replace(/=>/g, '__');
    for (const ch of stripped) {
      if (ch === '(' || ch === '{' || ch === '<' || ch === '[') {
        depth++;
      } else if (ch === ')' || ch === '}' || ch === '>' || ch === ']') {
        depth--;
      }
    }
    if (depth <= 0 && /;\s*$/.test(raw)) {
      return i;
    }
    i++;
  }
  return i;
};

const stripFile = (filePath) => {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (/^_{2,}[A-Za-z]/.test(trimmed)) {
      pruneDocBlock(out);
      i = skipMember(lines, i);
      continue;
    }

    out.push(line);
  }

  writeFileSync(filePath, out.join('\n'));
};

for (const file of files) {
  stripFile(file);
}
