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
          await proc.stdin.end();
        } catch (err: unknown) {
          // EPIPE is expected when the check process exits before reading all of stdin
          // (e.g. `grep -q` exits on first match). Anything else is a real failure.
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== 'EPIPE') throw err;
        }
      }

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        try {
          const stderr = await new Response(proc.stderr).text();
          if (stderr.trim()) {
            console.warn(`[output_check] "${checkCmd}" exit=${exitCode}: ${stderr.trim()}`);
          }
        } catch { /* ignore stderr read failures */ }
      }

      return exitCode === 0;
    } finally {
      clearTimeout(timer);
    }
  },
};
