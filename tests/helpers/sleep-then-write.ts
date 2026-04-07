import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ms = Number(Bun.argv[2] ?? '0');
const relativePath = Bun.argv[3];
const content = Bun.argv.slice(4).join(' ');

if (!relativePath) {
  console.error('usage: bun tests/helpers/sleep-then-write.ts <ms> <relative-path> [content]');
  process.exit(2);
}

await Bun.sleep(ms);

const fullPath = resolve(process.cwd(), relativePath);
await mkdir(dirname(fullPath), { recursive: true });

// Retry loop: on Windows, file watchers can hold a brief lock (EPERM/EBUSY)
// when a write lands immediately after chokidar detects a previous change.
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 200;
for (let attempt = 0; ; attempt++) {
  try {
    await Bun.write(fullPath, content ? `${content}\n` : '');
    break;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if ((code === 'EPERM' || code === 'EBUSY') && attempt < MAX_RETRIES) {
      await Bun.sleep(RETRY_DELAY_MS);
      continue;
    }
    throw err;
  }
}
console.log(`wrote-after:${ms}:${relativePath}`);
