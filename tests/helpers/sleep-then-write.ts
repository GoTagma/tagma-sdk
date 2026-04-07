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
await Bun.write(fullPath, content ? `${content}\n` : '');
console.log(`wrote-after:${ms}:${relativePath}`);
