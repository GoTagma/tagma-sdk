// hook-gate.ts — gate hook: exits 1 (block) if the task id in the JSON context
// matches the given target argument; exits 0 (allow) for everything else.
// Usage: bun tests/helpers/hook-gate.ts <target-task-id-suffix>
//
// The task.id in hook context is fully-qualified (e.g. "track.task_id").
// Matching: exact match OR the id ends with ".<target>".

const target = Bun.argv[2];
if (!target) {
  // No target → allow everything
  process.exit(0);
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.from(chunk));
}
const raw = Buffer.concat(chunks).toString('utf8');

let taskId = '';
try {
  const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const task = parsed.task as Record<string, unknown> | undefined;
  taskId = String(task?.id ?? '');
} catch {
  // Ignore parse errors — allow by default
  process.exit(0);
}

if (taskId === target || taskId.endsWith(`.${target}`)) {
  console.error(`[hook-gate] blocking task: ${taskId}`);
  process.exit(1);
}
process.exit(0);
