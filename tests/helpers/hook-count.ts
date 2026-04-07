// hook-count.ts — append a timestamp line to a counter file.
// Used to verify that hook array commands each fire exactly once per event.
// Usage: bun tests/helpers/hook-count.ts <relative-path>

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const relativePath = Bun.argv[2];
if (!relativePath) {
  process.exit(0); // no-op if no path given
}

const fullPath = resolve(process.cwd(), relativePath);
await mkdir(dirname(fullPath), { recursive: true });
await appendFile(fullPath, `${new Date().toISOString()}\n`, 'utf8');
console.log(`counted:${relativePath}`);
