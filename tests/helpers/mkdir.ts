// mkdir.ts — create a directory at the given relative path (from process.cwd())
// Usage: bun tests/helpers/mkdir.ts <relative-path>

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const relativePath = Bun.argv[2];
if (!relativePath) {
  console.error('usage: bun tests/helpers/mkdir.ts <relative-path>');
  process.exit(2);
}

const fullPath = resolve(process.cwd(), relativePath);
await mkdir(fullPath, { recursive: true });
console.log(`mkdir:${relativePath}`);
