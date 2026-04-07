// write-sized.ts — write a file with exactly <size> bytes of content.
// Usage: bun tests/helpers/write-sized.ts <relative-path> <size>

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const relativePath = Bun.argv[2];
const size = Number(Bun.argv[3] ?? '10');

if (!relativePath) {
  console.error('usage: bun tests/helpers/write-sized.ts <relative-path> <size>');
  process.exit(2);
}

const content = 'x'.repeat(Math.max(0, size));
const fullPath = resolve(process.cwd(), relativePath);
await mkdir(dirname(fullPath), { recursive: true });
await Bun.write(fullPath, content);
console.log(`wrote-sized:${size}:${relativePath}`);
