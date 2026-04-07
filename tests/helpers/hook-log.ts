import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const sample = Bun.argv[2] ?? 'unknown-sample';

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.from(chunk));
}
const raw = Buffer.concat(chunks).toString('utf8');

let parsed: Record<string, unknown> = {};
try {
  parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
} catch {
  parsed = { raw };
}

const event = String(parsed.event ?? 'unknown');
const task = (parsed.task as Record<string, unknown> | undefined) ?? {};
const track = (parsed.track as Record<string, unknown> | undefined) ?? {};

const line =
  `${new Date().toISOString()} sample=${sample} event=${event}` +
  ` track=${String(track.id ?? '-')}` +
  ` task=${String(task.id ?? '-')}` +
  ` status=${String(task.status ?? '-')}` +
  ` exit=${String(task.exit_code ?? '-')}` +
  '\n';

const outPath = resolve(process.cwd(), '.tagma-tests', 'hook-events.log');
await mkdir(dirname(outPath), { recursive: true });
await appendFile(outPath, line, 'utf8');
console.log(line.trim());
