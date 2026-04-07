import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { SpawnSpec, DriverPlugin, TaskResult, TaskConfig } from './types';
import { shellArgs } from './utils';

// Delay before escalating SIGTERM to SIGKILL when killing a timed-out process.
const SIGKILL_DELAY_MS = 3_000;

/**
 * On Windows, proc.kill('SIGTERM') / proc.kill('SIGKILL') only terminate the
 * direct child process. When the child is a .cmd/.bat wrapper (e.g. claude.cmd),
 * cmd.exe spawns the real process as a grandchild — proc.kill misses it entirely.
 * `taskkill /F /T /PID` kills the entire process tree rooted at the given PID.
 */
function killProcessTree(pid: number): void {
  if (process.platform !== 'win32') return;
  try {
    Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(pid)], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
  } catch {
    /* best-effort — process may have already exited */
  }
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal; // pipeline-level abort
}

/**
 * On Windows, Bun.spawn does NOT auto-append PATHEXT extensions like
 * CreateProcess does. A bare command like `claude` fails with ENOENT if the
 * actual file on disk is `claude.cmd` / `claude.bat` / `claude.ps1`. We
 * manually resolve the command against PATH + PATHEXT here so Drivers can
 * keep using short names (`claude`, `npx`, etc.) cross-platform.
 *
 * Results are cached by (cmd, envPath) key so repeated spawns of the same
 * command don't block the event loop with synchronous PATH scans.
 *
 * Returns the original name if resolution fails; Bun will raise the same
 * ENOENT it would have otherwise.
 */
const resolvedExeCache = new Map<string, string | null>();

function resolveWindowsExe(
  args: readonly string[],
  envPath: string,
): readonly string[] {
  if (process.platform !== 'win32' || args.length === 0) return args;
  const cmd = args[0]!;
  // Already a full path or has an extension → trust caller.
  if (isAbsolute(cmd) || /\.[a-z0-9]+$/i.test(cmd)) return args;

  const cacheKey = `${cmd}\x00${envPath}`;
  if (resolvedExeCache.has(cacheKey)) {
    // ?? null coerces undefined→null so cached is string|null and the !== null
    // check narrows it to string without a spurious 'undefined' arm.
    const cached = resolvedExeCache.get(cacheKey) ?? null;
    return cached !== null ? [cached, ...args.slice(1)] : args;
  }

  const exts = (
    process.env.PATHEXT ??
    '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
  )
    .split(';')
    .filter(Boolean);
  const dirs = envPath.split(';').filter(Boolean);

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) {
        resolvedExeCache.set(cacheKey, candidate);
        return [candidate, ...args.slice(1)];
      }
    }
  }
  resolvedExeCache.set(cacheKey, null);
  return args;
}

/** Build a "failed before spawn" result. */
function failResult(stderr: string, durationMs: number): TaskResult {
  return {
    exitCode: -1,
    stdout: '',
    stderr,
    outputPath: null,
    stderrPath: null,
    durationMs,
    sessionId: null,
    normalizedOutput: null,
  };
}

export async function runSpawn(
  spec: SpawnSpec,
  driver: DriverPlugin | null,
  opts: RunOptions = {},
): Promise<TaskResult> {
  const { timeoutMs, signal } = opts;
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);

  const mergedEnv = { ...process.env, ...(spec.env ?? {}) };
  const resolvedArgs = resolveWindowsExe(
    spec.args,
    mergedEnv.PATH ?? process.env.PATH ?? '',
  );

  // ── 1. Spawn (catch ENOENT / bad-cwd up front) ────────────────────────
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(resolvedArgs as string[], {
      cwd: spec.cwd,
      env: mergedEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: spec.stdin ? 'pipe' : undefined,
    });
  } catch (err) {
    return failResult(String(err), elapsed());
  }

  // ── 2. Write stdin ─────────────────────────────────────────────────────
  // Child may exit before reading (e.g. quick-fail commands that don't
  // touch stdin) → swallow EPIPE rather than surfacing it as an
  // engine-level error.
  if (spec.stdin && proc.stdin && typeof proc.stdin !== 'number') {
    try {
      proc.stdin.write(spec.stdin);
      proc.stdin.end();
    } catch {
      /* ignore EPIPE / closed-pipe errors */
    }
  }

  // ── 3. Timeout & abort handling ────────────────────────────────────────
  let killedByUs = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;

  const killGracefully = () => {
    if (killedByUs) return;
    killedByUs = true;

    if (process.platform === 'win32') {
      // On Windows, kill the entire process tree via taskkill. This handles
      // .cmd wrappers and nested child processes that proc.kill() misses.
      killProcessTree(proc.pid);
    } else {
      proc.kill('SIGTERM');
      // If the child ignores SIGTERM, escalate to SIGKILL after 3 s.
      forceTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, SIGKILL_DELAY_MS);
    }
  };

  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(killGracefully, timeoutMs);
  }

  const onAbort = () => killGracefully();
  if (signal) {
    if (signal.aborted) {
      killGracefully();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // ── 4. Collect output & wait (parallel to avoid pipe-buffer deadlock) ─
  const stdoutStream = typeof proc.stdout === 'object' ? proc.stdout : undefined;
  const stderrStream = typeof proc.stderr === 'object' ? proc.stderr : undefined;

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    stdoutStream ? new Response(stdoutStream).text() : Promise.resolve(''),
    stderrStream ? new Response(stderrStream).text() : Promise.resolve(''),
  ]);

  // ── 5. Cleanup timers & listeners ──────────────────────────────────────
  if (timer) clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  if (signal) signal.removeEventListener('abort', onAbort);

  const durationMs = elapsed();

  // We initiated the kill (timeout or abort) — always treat as non-success
  // regardless of exit code. A process that catches SIGTERM and exits 0 still
  // hit the timeout; letting it pass as success would unblock downstream tasks
  // incorrectly.
  if (killedByUs) {
    return {
      exitCode: -1,
      stdout,
      stderr,
      outputPath: null,
      stderrPath: null,
      durationMs,
      sessionId: null,
      normalizedOutput: null,
    };
  }

  // ── 6. Let driver extract metadata ─────────────────────────────────────
  const meta = driver?.parseResult?.(stdout, stderr) ?? {};

  return {
    exitCode,
    stdout,
    stderr,
    outputPath: null,
    stderrPath: null,
    durationMs,
    sessionId: meta.sessionId ?? null,
    normalizedOutput: meta.normalizedOutput ?? null,
  };
}

export async function runCommand(
  command: string,
  cwd: string,
  opts: RunOptions = {},
): Promise<TaskResult> {
  const spec: SpawnSpec = {
    args: shellArgs(command),
    cwd,
  };
  return runSpawn(spec, null, opts);
}