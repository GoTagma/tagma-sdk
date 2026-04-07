import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const relativePath = Bun.argv[2];
const content = Bun.argv.slice(3).join(' ');

if (!relativePath) {
  console.error('usage: bun tests/helpers/write-file.ts <relative-path> [content]');
  process.exit(2);
}

const fullPath = resolve(process.cwd(), relativePath);
await mkdir(dirname(fullPath), { recursive: true });
await Bun.write(fullPath, content ? `${content}\n` : '');
console.log(`wrote:${relativePath}`);
