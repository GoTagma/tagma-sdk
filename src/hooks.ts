import type { HooksConfig, HookCommand } from './types';
import { shellArgs } from './utils';

type HookEvent =
  | 'pipeline_start' | 'task_start' | 'task_success'
  | 'task_failure' | 'pipeline_complete' | 'pipeline_error';

const GATE_HOOKS: ReadonlySet<HookEvent> = new Set(['pipeline_start', 'task_start']);

export interface HookResult {
  readonly allowed: boolean;  // for gate hooks: true = proceed, false = block
  readonly exitCode: number;
}

function normalizeCommands(cmd: HookCommand | undefined): readonly string[] {
  if (!cmd) return [];
  if (typeof cmd === 'string') return [cmd];
  return cmd;
}

async function runSingleHook(command: string, context: unknown, cwd?: string): Promise<number> {
  const jsonInput = JSON.stringify(context, null, 2);

  const proc = Bun.spawn(shellArgs(command) as string[], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(cwd ? { cwd } : {}),
  });

  if (proc.stdin) {
    try {
      proc.stdin.write(jsonInput);
      proc.stdin.end();
    } catch {
      // Process may exit before reading stdin (e.g. `exit 1`), ignore EPIPE
    }
  }

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  if (stderr.trim()) {
    console.error(`[hook: ${command}] stderr: ${stderr.trim()}`);
  }

  return exitCode;
}

export async function executeHook(
  hooks: HooksConfig | undefined,
  event: HookEvent,
  context: unknown,
  workDir?: string,
): Promise<HookResult> {
  if (!hooks) return { allowed: true, exitCode: 0 };

  const commands = normalizeCommands(hooks[event]);
  if (commands.length === 0) return { allowed: true, exitCode: 0 };

  const isGate = GATE_HOOKS.has(event);

  for (const cmd of commands) {
    const exitCode = await runSingleHook(cmd, context, workDir);

    if (isGate && exitCode === 1) {
      // Only exit code 1 has gate semantics (block execution)
      return { allowed: false, exitCode };
    }

    if (exitCode !== 0) {
      // Non-zero but not 1: hook itself had an error, log but don't block
      console.warn(`[hook: ${event}] "${cmd}" exited with code ${exitCode}`);
    }
  }

  return { allowed: true, exitCode: 0 };
}

// ═══ Context Builders ═══

export interface PipelineInfo {
  readonly name: string;
  readonly run_id: string;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly duration_ms?: number;
}

export interface TrackInfo {
  readonly id: string;
  readonly name: string;
}

export interface TaskInfo {
  readonly id: string;
  readonly name: string;
  readonly type: 'ai' | 'command';
  readonly status: string;
  readonly exit_code: number | null;
  readonly duration_ms: number | null;
  readonly output_path: string | null;
  readonly stderr_path: string | null;
  readonly session_id: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export function buildPipelineStartContext(pipeline: PipelineInfo) {
  return { event: 'pipeline_start', pipeline };
}

export function buildTaskContext(
  event: 'task_start' | 'task_success' | 'task_failure',
  pipeline: PipelineInfo,
  track: TrackInfo,
  task: TaskInfo,
) {
  return { event, pipeline, track, task };
}

export function buildPipelineCompleteContext(
  pipeline: PipelineInfo & { finished_at: string; duration_ms: number },
  summary: {
    total: number; success: number; failed: number;
    skipped: number; timeout: number; blocked: number;
  },
) {
  return { event: 'pipeline_complete', pipeline, summary };
}

export function buildPipelineErrorContext(
  pipeline: PipelineInfo,
  error: string,
  eventType?: string,
) {
  return { event: eventType ?? 'pipeline_error', pipeline, error };
}
