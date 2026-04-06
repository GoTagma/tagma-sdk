import { resolve, dirname } from 'path';
import { mkdir, readdir, rm } from 'fs/promises';
import type {
  PipelineConfig, TaskConfig, TrackConfig, TaskState, TaskStatus,
  TaskResult, DriverPlugin, TriggerPlugin, CompletionPlugin,
  MiddlewarePlugin, MiddlewareContext, DriverContext,
  OnFailure,
} from './types';
import { buildDag, type Dag, type DagNode } from './dag';
import { getHandler, hasHandler, loadPlugins } from './registry';
import { runSpawn, runCommand } from './runner';
import { parseDuration, nowISO, generateRunId } from './utils';
import {
  executeHook,
  buildPipelineStartContext, buildTaskContext,
  buildPipelineCompleteContext, buildPipelineErrorContext,
  type PipelineInfo, type TrackInfo, type TaskInfo,
} from './hooks';
import { Logger, tailLines, clip } from './logger';
import { InMemoryApprovalGateway, type ApprovalGateway } from './approval';

// ═══ Preflight Validation ═══

function preflight(config: PipelineConfig, dag: Dag): void {
  const errors: string[] = [];

  for (const [, node] of dag.nodes) {
    const task = node.task;
    const track = node.track;
    const driverName = task.driver ?? track.driver ?? config.driver ?? 'claude-code';

    if (!hasHandler('drivers', driverName)) {
      errors.push(`Task "${node.taskId}": driver "${driverName}" not registered`);
    }

    if (task.trigger && !hasHandler('triggers', task.trigger.type)) {
      errors.push(`Task "${node.taskId}": trigger type "${task.trigger.type}" not registered`);
    }

    if (task.completion && !hasHandler('completions', task.completion.type)) {
      errors.push(`Task "${node.taskId}": completion type "${task.completion.type}" not registered`);
    }

    const mws = task.middlewares ?? track.middlewares ?? [];
    for (const mw of mws) {
      if (!hasHandler('middlewares', mw.type)) {
        errors.push(`Task "${node.taskId}": middleware type "${mw.type}" not registered`);
      }
    }

    if (task.continue_from && hasHandler('drivers', driverName)) {
      const driver = getHandler<DriverPlugin>('drivers', driverName);
      if (!driver.capabilities.sessionResume) {
        const upstreamId = resolveRefInDag(dag, task.continue_from, track.id);
        if (upstreamId) {
          const upstream = dag.nodes.get(upstreamId);
          if (upstream && !upstream.task.output) {
            errors.push(
              `Task "${node.taskId}" uses continue_from: "${task.continue_from}", ` +
              `but upstream task "${upstreamId}" has no "output" field. ` +
              `Add output to the upstream task, or remove continue_from.`
            );
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Preflight validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}

function resolveRefInDag(dag: Dag, ref: string, fromTrackId: string): string | null {
  if (dag.nodes.has(ref)) return ref;
  const sameTrack = `${fromTrackId}.${ref}`;
  if (dag.nodes.has(sameTrack)) return sameTrack;
  for (const [id] of dag.nodes) {
    if (id.endsWith(`.${ref}`)) return id;
  }
  return null;
}

// ═══ Engine ═══

export interface EngineResult {
  readonly success: boolean;
  readonly runId: string;
  readonly logPath: string;
  readonly summary: {
    total: number; success: number; failed: number;
    skipped: number; timeout: number; blocked: number;
  };
  readonly states: ReadonlyMap<string, TaskState>;
}

// ═══ Pipeline Events ═══

export type PipelineEvent =
  | { readonly type: 'task_status_change'; readonly taskId: string; readonly status: TaskStatus; readonly prevStatus: TaskStatus; readonly runId: string }
  | { readonly type: 'pipeline_start'; readonly runId: string }
  | { readonly type: 'pipeline_end'; readonly runId: string; readonly success: boolean };

export interface RunPipelineOptions {
  readonly approvalGateway?: ApprovalGateway;
  /**
   * Maximum number of per-run log directories to retain under `<workDir>/logs/`.
   * Oldest directories are deleted after each run. Defaults to 20. Set to 0 to disable cleanup.
   */
  readonly maxLogRuns?: number;
  /**
   * External AbortSignal — aborting it cancels the pipeline immediately.
   * Equivalent to the pipeline timeout firing, but caller-controlled.
   */
  readonly signal?: AbortSignal;
  /**
   * Called on every pipeline/task status transition.
   * Use for real-time UI updates (e.g. updating a visual workflow graph).
   */
  readonly onEvent?: (event: PipelineEvent) => void;
}

export async function runPipeline(
  config: PipelineConfig,
  workDir: string,
  options: RunPipelineOptions = {},
): Promise<EngineResult> {
  const approvalGateway = options.approvalGateway ?? new InMemoryApprovalGateway();
  const maxLogRuns = options.maxLogRuns ?? 20;

  // Load any plugins declared in the pipeline config before preflight so that
  // drivers, completions, and middlewares referenced in YAML are registered.
  if (config.plugins?.length) {
    await loadPlugins(config.plugins);
  }

  const dag = buildDag(config);
  const runId = generateRunId();
  preflight(config, dag);

  const startedAt = nowISO();
  const pipelineInfo: PipelineInfo = { name: config.name, run_id: runId, started_at: startedAt };
  const log = new Logger(workDir, runId);
  log.info('[pipeline]', `start "${config.name}" run_id=${runId}`);

  // File-only: dump the resolved pipeline shape + DAG topology for post-mortem.
  log.section('Pipeline configuration');
  log.quiet(`name:          ${config.name}`);
  log.quiet(`driver:        ${config.driver ?? '(default: claude-code)'}`);
  log.quiet(`timeout:       ${config.timeout ?? '(none)'}`);
  log.quiet(`tracks:        ${config.tracks.length}`);
  log.quiet(`tasks (total): ${dag.nodes.size}`);
  log.quiet(`plugins:       ${(config.plugins ?? []).join(', ') || '(none)'}`);
  log.quiet(`hooks:         ${config.hooks ? Object.keys(config.hooks).join(', ') || '(none)' : '(none)'}`);

  log.section('DAG topology');
  for (const [id, node] of dag.nodes) {
    const deps = node.dependsOn.length ? node.dependsOn.join(', ') : '(root)';
    const kind = node.task.prompt ? 'ai' : 'cmd';
    log.quiet(`  • ${id}  [${kind}]  track=${node.track.id}  deps=[${deps}]`);
  }
  log.quiet('');

  // Initialize states (before hook, so we can return them even if blocked)
  const states = new Map<string, TaskState>();
  for (const [id, node] of dag.nodes) {
    states.set(id, {
      config: node.task,
      trackConfig: node.track,
      status: 'idle',
      result: null,
      startedAt: null,
      finishedAt: null,
    });
  }

  try {

  // Pipeline start hook (gate)
  const startHook = await executeHook(
    config.hooks, 'pipeline_start', buildPipelineStartContext(pipelineInfo), workDir,
  );
  if (!startHook.allowed) {
    console.error(`Pipeline blocked by pipeline_start hook (exit code ${startHook.exitCode})`);
    await executeHook(config.hooks, 'pipeline_error',
      buildPipelineErrorContext(pipelineInfo, 'pipeline_blocked', 'pipeline_blocked'), workDir);
    // All tasks stay idle — pipeline never started
    return {
      success: false,
      runId,
      logPath: log.path,
      summary: { total: dag.nodes.size, success: 0, failed: 0, skipped: 0, timeout: 0, blocked: 0 },
      states,
    };
  }

  // Pipeline approved — transition all tasks to waiting
  for (const [, state] of states) {
    state.status = 'waiting';
  }
  options.onEvent?.({ type: 'pipeline_start', runId });

  const sessionMap = new Map<string, string>();
  const outputMap = new Map<string, string>();
  const normalizedMap = new Map<string, string>();

  // Pipeline timeout
  const pipelineTimeoutMs = config.timeout ? parseDuration(config.timeout) : 0;
  let pipelineAborted = false;
  const abortController = new AbortController();
  let pipelineTimer: ReturnType<typeof setTimeout> | null = null;

  if (pipelineTimeoutMs > 0) {
    pipelineTimer = setTimeout(() => {
      pipelineAborted = true;
      abortController.abort();
    }, pipelineTimeoutMs);
  }

  // When the pipeline is aborted (timeout, external shutdown), drain all
  // pending approvals so waiting triggers unblock immediately.
  abortController.signal.addEventListener('abort', () => {
    approvalGateway.abortAll('pipeline aborted');
  });

  // Wire external cancel signal into the internal abort controller.
  if (options.signal) {
    if (options.signal.aborted) {
      pipelineAborted = true;
      abortController.abort();
    } else {
      options.signal.addEventListener('abort', () => {
        pipelineAborted = true;
        abortController.abort();
      }, { once: true });
    }
  }

  // ── Helpers ──

  function emit(event: PipelineEvent): void {
    options.onEvent?.(event);
  }

  function setTaskStatus(taskId: string, newStatus: TaskStatus): void {
    const state = states.get(taskId)!;
    const prevStatus = state.status;
    state.status = newStatus;
    emit({ type: 'task_status_change', taskId, status: newStatus, prevStatus, runId });
  }

  function getOnFailure(taskId: string): OnFailure {
    return dag.nodes.get(taskId)?.track.on_failure ?? 'skip_downstream';
  }

  function isDependencySatisfied(depId: string): 'satisfied' | 'unsatisfied' | 'skip' {
    const depState = states.get(depId);
    if (!depState) return 'skip';
    switch (depState.status) {
      case 'success': return 'satisfied';
      case 'skipped': return 'skip';
      case 'failed': case 'timeout': case 'blocked':
        return getOnFailure(depId) === 'ignore' ? 'satisfied' : 'skip';
      default: return 'unsatisfied';
    }
  }

  function applyStopAll(trackId: string): void {
    for (const [id, state] of states) {
      if (state.trackConfig.id === trackId && !isTerminal(state.status)) {
        setTaskStatus(id, 'skipped');
        state.finishedAt = nowISO();
      }
    }
  }

  function buildTaskInfoObj(taskId: string): TaskInfo {
    const state = states.get(taskId)!;
    return {
      id: taskId,
      name: state.config.name,
      type: state.config.prompt ? 'ai' : 'command',
      status: state.status,
      exit_code: state.result?.exitCode ?? null,
      duration_ms: state.result?.durationMs ?? null,
      output_path: state.result?.outputPath ?? null,
      stderr_path: state.result?.stderrPath ?? null,
      session_id: state.result?.sessionId ?? null,
      started_at: state.startedAt,
      finished_at: state.finishedAt,
    };
  }

  function trackInfoOf(taskId: string): TrackInfo {
    const node = dag.nodes.get(taskId)!;
    return { id: node.track.id, name: node.track.name };
  }

  async function fireHook(taskId: string, event: 'task_success' | 'task_failure'): Promise<void> {
    await executeHook(config.hooks, event,
      buildTaskContext(event, pipelineInfo, trackInfoOf(taskId), buildTaskInfoObj(taskId)), workDir);
  }

  // ── Process a single task ──

  async function processTask(taskId: string): Promise<void> {
    const state = states.get(taskId)!;
    const node = dag.nodes.get(taskId)!;
    const task = node.task;
    const track = node.track;

    log.section(`Task ${taskId}`);
    log.debug(`[task:${taskId}]`,
      `type=${task.prompt ? 'ai' : 'cmd'} track=${track.id} deps=[${node.dependsOn.join(', ') || '(root)'}]`);

    // 1. Check dependencies
    for (const depId of node.dependsOn) {
      const result = isDependencySatisfied(depId);
      if (result === 'skip') {
        const depStatus = states.get(depId)?.status ?? 'unknown';
        log.debug(`[task:${taskId}]`, `skipped (upstream "${depId}" status=${depStatus})`);
        setTaskStatus(taskId, 'skipped');
        state.finishedAt = nowISO();
        return;
      }
      if (result === 'unsatisfied') return; // still waiting
    }

    // 2. Check trigger
    if (task.trigger) {
      log.debug(`[task:${taskId}]`, `trigger wait: type=${task.trigger.type} ${JSON.stringify(task.trigger)}`);
      try {
        const triggerPlugin = getHandler<TriggerPlugin>('triggers', task.trigger.type);
        await triggerPlugin.watch(task.trigger as Record<string, unknown>, {
          taskId: node.taskId,
          trackId: track.id,
          workDir: task.cwd ?? workDir,
          signal: abortController.signal,
          approvalGateway,
        });
        log.debug(`[task:${taskId}]`, `trigger fired`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // If pipeline was aborted while we were still waiting for the trigger,
        // this task never entered running state → skipped, not timeout.
        if (pipelineAborted) {
          setTaskStatus(taskId, 'skipped');
        } else if (msg.includes('rejected') || msg.includes('denied')) {
          setTaskStatus(taskId, 'blocked');       // user/policy rejection
        } else if (msg.includes('timeout')) {
          setTaskStatus(taskId, 'timeout');       // genuine trigger wait timeout
        } else {
          setTaskStatus(taskId, 'failed');        // plugin error, watcher crash, etc.
        }
        state.finishedAt = nowISO();
        await fireHook(taskId, 'task_failure');
        return;
      }
    }

    // 3. task_start hook (gate)
    const hookResult = await executeHook(config.hooks, 'task_start',
      buildTaskContext('task_start', pipelineInfo, trackInfoOf(taskId), buildTaskInfoObj(taskId)), workDir);
    if (hookResult.exitCode !== 0 || config.hooks?.task_start) {
      log.debug(`[task:${taskId}]`,
        `task_start hook exit=${hookResult.exitCode} allowed=${hookResult.allowed}`);
    }
    if (!hookResult.allowed) {
      setTaskStatus(taskId, 'blocked');
      state.finishedAt = nowISO();
      await fireHook(taskId, 'task_failure');
      return;
    }

    // 4. Mark running
    setTaskStatus(taskId, 'running');
    state.startedAt = nowISO();
    log.info(`[task:${taskId}]`, task.command ? `running: ${task.command}` : `running (driver task)`);

    // File-only: resolved config for this task
    const resolvedDriver = task.driver ?? track.driver ?? config.driver ?? 'claude-code';
    const resolvedTier = task.model_tier ?? track.model_tier ?? '(default)';
    const resolvedPerms = task.permissions ?? track.permissions ?? '(default)';
    const resolvedCwd = task.cwd ?? track.cwd ?? workDir;
    log.debug(`[task:${taskId}]`,
      `resolved: driver=${resolvedDriver} tier=${resolvedTier} cwd=${resolvedCwd}`);
    log.debug(`[task:${taskId}]`, `permissions: ${JSON.stringify(resolvedPerms)}`);
    if (task.continue_from) {
      log.debug(`[task:${taskId}]`, `continue_from: "${task.continue_from}"`);
    }
    if (task.timeout) {
      log.debug(`[task:${taskId}]`, `timeout: ${task.timeout}`);
    }

    try {
      let result: TaskResult;
      const timeoutMs = task.timeout ? parseDuration(task.timeout) : undefined;

      const runOpts = { timeoutMs, signal: abortController.signal };

      if (task.command) {
        log.debug(`[task:${taskId}]`, `command: ${task.command}`);
        result = await runCommand(task.command, task.cwd ?? workDir, runOpts);
      } else {
        // AI task: apply middleware chain
        const driverName = task.driver ?? track.driver ?? config.driver ?? 'claude-code';
        const driver = getHandler<DriverPlugin>('drivers', driverName);

        let prompt = task.prompt!;
        const originalLen = prompt.length;
        const mws = task.middlewares !== undefined ? task.middlewares : track.middlewares;
        if (mws && mws.length > 0) {
          log.debug(`[task:${taskId}]`,
            `middleware chain: ${mws.map(m => m.type).join(' → ')}`);
          const mwCtx: MiddlewareContext = {
            task, track, outputMap, workDir: task.cwd ?? workDir,
          };
          for (const mwConfig of mws) {
            const before = prompt.length;
            const mwPlugin = getHandler<MiddlewarePlugin>('middlewares', mwConfig.type);
            prompt = await mwPlugin.enhance(prompt, mwConfig as Record<string, unknown>, mwCtx);
            log.debug(`[task:${taskId}]`,
              `  ${mwConfig.type}: ${before} → ${prompt.length} chars`);
          }
        }
        log.debug(`[task:${taskId}]`,
          `prompt: ${originalLen} chars (final: ${prompt.length} chars)`);
        log.quiet(`--- prompt (final) ---\n${clip(prompt)}\n--- end prompt ---`);

        const enrichedTask: TaskConfig = { ...task, prompt };
        const driverCtx: DriverContext = {
          sessionMap, outputMap, normalizedMap, workDir: task.cwd ?? workDir,
        };
        const spec = await driver.buildCommand(enrichedTask, track, driverCtx);
        log.debug(`[task:${taskId}]`, `driver=${driverName}`);
        log.debug(`[task:${taskId}]`,
          `spawn args: ${JSON.stringify(spec.args)}`);
        if (spec.cwd) log.debug(`[task:${taskId}]`, `spawn cwd: ${spec.cwd}`);
        if (spec.env) log.debug(`[task:${taskId}]`,
          `spawn env overrides: ${Object.keys(spec.env).join(', ')}`);
        if (spec.stdin) log.debug(`[task:${taskId}]`,
          `spawn stdin: ${spec.stdin.length} chars`);
        result = await runSpawn(spec, driver, runOpts);
      }

      // 5. Determine status
      if (result.exitCode === -1) {
        setTaskStatus(taskId, 'timeout');
      } else if (result.exitCode !== 0) {
        setTaskStatus(taskId, 'failed');
      } else if (task.completion) {
        const plugin = getHandler<CompletionPlugin>('completions', task.completion.type);
        const completionCtx = { workDir: task.cwd ?? workDir };
        const passed = await plugin.check(task.completion as Record<string, unknown>, result, completionCtx);
        setTaskStatus(taskId, passed ? 'success' : 'failed');
      } else {
        setTaskStatus(taskId, 'success');
      }

      // 6. Write output file with RAW stdout (preserves driver output format).
      // The separate normalizedMap holds canonical text for continue_from.
      if (task.output) {
        const outPath = resolve(workDir, task.output);
        await mkdir(dirname(outPath), { recursive: true });
        await Bun.write(outPath, result.stdout);
        result = { ...result, outputPath: outPath };
        outputMap.set(taskId, outPath);
        const bareId = taskId.includes('.') ? taskId.split('.').pop()! : taskId;
        if (!outputMap.has(bareId)) outputMap.set(bareId, outPath);
      }

      // Store normalized text separately (in-memory) for continue_from handoff
      if (result.normalizedOutput !== null) {
        normalizedMap.set(taskId, result.normalizedOutput);
        const bareId = taskId.includes('.') ? taskId.split('.').pop()! : taskId;
        if (!normalizedMap.has(bareId)) normalizedMap.set(bareId, result.normalizedOutput);
      }

      if (result.stderr) {
        const stderrPath = resolve(log.dir, `${taskId.replace(/\./g, '_')}.stderr`);
        await Bun.write(stderrPath, result.stderr);
        result = { ...result, stderrPath };
      }

      if (result.sessionId) {
        sessionMap.set(taskId, result.sessionId);
        const bareId = taskId.includes('.') ? taskId.split('.').pop()! : taskId;
        if (!sessionMap.has(bareId)) sessionMap.set(bareId, result.sessionId);
      }

      state.result = result;
      state.finishedAt = nowISO();

      // Log task outcome with relevant details
      const durSec = (result.durationMs / 1000).toFixed(1);
      if (state.status === 'success') {
        log.info(`[task:${taskId}]`, `success (${durSec}s)`);
      } else {
        log.error(`[task:${taskId}]`,
          `${state.status} exit=${result.exitCode} duration=${durSec}s`);
        if (result.stderr) {
          const tail = tailLines(result.stderr, 10);
          log.error(`[task:${taskId}]`, `stderr tail:\n${tail}`);
        }
      }

      // File-only: full stdout/stderr dump (clipped) + extracted metadata
      log.debug(`[task:${taskId}]`,
        `stdout: ${result.stdout.length} chars, stderr: ${result.stderr.length} chars`);
      if (result.sessionId) {
        log.debug(`[task:${taskId}]`, `sessionId: ${result.sessionId}`);
      }
      if (result.outputPath) {
        log.debug(`[task:${taskId}]`, `wrote output: ${result.outputPath}`);
      }
      if (result.stderrPath) {
        log.debug(`[task:${taskId}]`, `wrote stderr: ${result.stderrPath}`);
      }
      if (result.stdout) {
        log.quiet(`--- stdout (${taskId}) ---\n${clip(result.stdout)}\n--- end stdout ---`);
      }
      if (result.stderr) {
        log.quiet(`--- stderr (${taskId}) ---\n${clip(result.stderr)}\n--- end stderr ---`);
      }
      if (task.completion) {
        log.debug(`[task:${taskId}]`,
          `completion check: type=${task.completion.type} result=${state.status}`);
      }

    } catch (err: unknown) {
      setTaskStatus(taskId, 'failed');
      state.finishedAt = nowISO();
      const errMsg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log.error(`[task:${taskId}]`, `failed before execution: ${errMsg}`);
      state.result = {
        exitCode: -1,
        stdout: '',
        stderr: errMsg,
        outputPath: null, stderrPath: null, durationMs: 0,
        sessionId: null, normalizedOutput: null,
      };
    }

    // 7. Fire hooks
    const finalStatus: TaskStatus = state.status;
    await fireHook(taskId, finalStatus === 'success' ? 'task_success' : 'task_failure');

    // 8. Handle stop_all for failure states
    if (finalStatus !== 'success' && getOnFailure(taskId) === 'stop_all') {
      applyStopAll(node.track.id);
    }
  }

  // ── Event loop ──
  // Each task is launched as soon as ALL its deps reach a terminal state.
  // We track in-flight tasks in `running` so a task completing mid-batch
  // immediately unblocks its dependents without waiting for sibling tasks.
  const running = new Map<string, Promise<void>>();

  try {
    while (!pipelineAborted) {
      // Launch every task whose deps are all terminal and that isn't already in-flight
      for (const [id, state] of states) {
        if (state.status !== 'waiting' || running.has(id)) continue;
        const node = dag.nodes.get(id)!;
        const allDepsTerminal = node.dependsOn.length === 0 ||
          node.dependsOn.every(d => isTerminal(states.get(d)!.status));
        if (!allDepsTerminal) continue;
        const p = processTask(id).finally(() => running.delete(id));
        running.set(id, p);
      }

      // All tasks terminal — done
      if ([...states.values()].every(s => isTerminal(s.status))) break;

      if (running.size === 0) {
        // Nothing in-flight but non-terminal tasks exist (e.g. trigger-wait states
        // that processTask hasn't been called for yet). Poll briefly.
        await new Promise(r => setTimeout(r, 50));
      } else {
        // Wait for any one task to finish, then re-scan for new launchables.
        await Promise.race(running.values());
      }
    }

    if (pipelineAborted) {
      // Wait for in-flight tasks to honour the abort signal before marking states.
      if (running.size > 0) await Promise.allSettled(running.values());
      for (const [id, state] of states) {
        if (!isTerminal(state.status)) {
          // Running tasks get timeout (they were killed); waiting tasks get skipped
          setTaskStatus(id, state.status === 'running' ? 'timeout' : 'skipped');
          state.finishedAt = nowISO();
        }
      }
    }
  } finally {
    if (pipelineTimer) clearTimeout(pipelineTimer);
    // Safety net: drain any approvals still pending at shutdown (e.g. crash path).
    if (approvalGateway.pending().length > 0) {
      approvalGateway.abortAll('pipeline finished');
    }
  }

  // ── Summary ──
  const summary = { total: 0, success: 0, failed: 0, skipped: 0, timeout: 0, blocked: 0 };
  for (const [, state] of states) {
    summary.total++;
    switch (state.status) {
      case 'success': summary.success++; break;
      case 'failed':  summary.failed++; break;
      case 'skipped': summary.skipped++; break;
      case 'timeout': summary.timeout++; break;
      case 'blocked': summary.blocked++; break;
    }
  }

  const finishedAt = nowISO();
  const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  if (pipelineAborted) {
    await executeHook(config.hooks, 'pipeline_error',
      buildPipelineErrorContext(pipelineInfo, 'Pipeline timeout exceeded'), workDir);
  } else {
    await executeHook(config.hooks, 'pipeline_complete',
      buildPipelineCompleteContext(
        { ...pipelineInfo, finished_at: finishedAt, duration_ms: durationMs }, summary), workDir);
  }

  const allSuccess = !pipelineAborted
    && summary.failed === 0 && summary.timeout === 0 && summary.blocked === 0;

  log.section('Pipeline summary');
  log.quiet(`status:   ${pipelineAborted ? 'aborted (timeout)' : 'completed'}`);
  log.quiet(`duration: ${(durationMs / 1000).toFixed(1)}s`);
  log.quiet(
    `counts:   total=${summary.total} success=${summary.success} ` +
    `failed=${summary.failed} skipped=${summary.skipped} ` +
    `timeout=${summary.timeout} blocked=${summary.blocked}`);
  log.quiet('');
  log.quiet('per-task:');
  for (const [id, state] of states) {
    const dur = state.result?.durationMs != null
      ? `${(state.result.durationMs / 1000).toFixed(1)}s` : '-';
    const exit = state.result?.exitCode ?? '-';
    log.quiet(`  ${state.status.padEnd(8)} ${id}  (exit=${exit}, ${dur})`);
  }

  console.log(`\n[Pipeline "${config.name}"] completed`);
  console.log(`  Total: ${summary.total} | Success: ${summary.success} | Failed: ${summary.failed} | Skipped: ${summary.skipped} | Timeout: ${summary.timeout} | Blocked: ${summary.blocked}`);
  console.log(`  Duration: ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  Log: ${log.path}`);

  emit({ type: 'pipeline_end', runId, success: allSuccess });
  return { success: allSuccess, runId, logPath: log.path, summary, states };

  } finally {
    // Prune old per-run log directories on every exit path (normal, blocked, or thrown).
    // Exclude the current runId so a concurrent run cannot delete its own live directory.
    if (maxLogRuns > 0) {
      await pruneLogDirs(resolve(workDir, 'logs'), maxLogRuns, runId);
    }
  }
}

/**
 * Delete the oldest subdirectories under `logsDir`, keeping only the most recent `keep`.
 * Directories are sorted lexicographically; because runIds are prefixed with a base-36
 * timestamp, lexicographic order equals chronological order.
 *
 * `excludeRunId` is always skipped from deletion even if it would otherwise be pruned —
 * this prevents a concurrent run from removing a live log directory that is still in use.
 */
async function pruneLogDirs(logsDir: string, keep: number, excludeRunId: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return; // logsDir doesn't exist yet — nothing to prune
  }

  // Only consider directories that look like run IDs (run_<...>), excluding the live run.
  const runDirs = entries.filter(e => e.startsWith('run_') && e !== excludeRunId).sort();
  const toDelete = runDirs.slice(0, Math.max(0, runDirs.length - keep));

  await Promise.all(
    toDelete.map(dir =>
      rm(resolve(logsDir, dir), { recursive: true, force: true }).catch(() => {
        // Ignore deletion errors — stale dirs are better than a crash
      })
    )
  );
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'success' || status === 'failed' || status === 'timeout'
    || status === 'skipped' || status === 'blocked';
}
