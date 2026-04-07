import type { CompletionPlugin, CompletionContext, TaskResult } from '../types';
import { shellArgs, parseDuration } from '../utils';

const DEFAULT_TIMEOUT_MS = 30_000;

export const OutputCheckCompletion: CompletionPlugin = {
  name: 'output_check',

  async check(config: Record<string, unknown>, result: TaskResult, ctx: CompletionContext): Promise<boolean> {
    const checkCmd = config.check as string;
    if (!checkCmd) throw new Error('output_check completion: "check" is required');

    const timeoutMs = config.timeout != null
      ? parseDuration(String(config.timeout))
      : DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const proc = Bun.spawn(shellArgs(checkCmd) as string[], {
      cwd: ctx.workDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      signal: controller.signal,
    });

    try {
      if (proc.stdin) {
        try {
          proc.stdin.write(result.stdout);
          proc.stdin.end(); // no await — consistent with runner.ts; proc.exited handles sync
        } catch (err: unknown) {
          // EPIPE is expected when the check process exits before reading all of stdin
          // (e.g. `grep -q` exits on first match). Anything else is a real failure.
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== 'EPIPE') throw err;
        }
      }

      // Consume stderr concurrently with waiting for exit to prevent pipe-buffer
      // deadlock when check script emits more than ~64 KB of stderr output.
      const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);

      if (exitCode !== 0 && stderr.trim()) {
        console.warn(`[output_check] "${checkCmd}" exit=${exitCode}: ${stderr.trim()}`);
      }

      return exitCode === 0;
    } finally {
      clearTimeout(timer);
    }
  },
};
