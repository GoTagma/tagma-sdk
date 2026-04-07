import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  bootstrapBuiltins,
  InMemoryApprovalGateway,
  loadPipeline,
  runPipeline,
  PipelineRunner,
} from '../src/sdk';
import type { EngineResult } from '../src/sdk';

// ═══ Case Registry ═══

const CASES = [
  // ── Local-only cases ──
  '01-command-smoke',
  '02-manual-ignore',
  '03-stopall-timeout',
  '04-pipeline-timeout',
  '07-hook-gate-pipeline',
  '08-hook-gate-task',
  '09-skip-downstream',
  '10-manual-reject',
  '11-manual-timeout',
  '12-exit-code-variants',
  '13-file-exists-variants',
  '14-file-trigger-exists',
  '15-hook-array',
  '16-cwd-override',
  '18-signal-cancel',
  '19-ignore-cross-track',
  '20-track-cwd',
  '22-file-trigger-change',
  // ── AI cases (require claude-code / codex) ──
  '05-claude-haiku',
  '06-codex-plugin',
  '17-track-middlewares',
] as const;

type CaseName = typeof CASES[number];

function isCaseName(value: string): value is CaseName {
  return (CASES as readonly string[]).includes(value);
}

// ═══ Expected Results & Per-Case Config ═══

interface ExpectedSummary {
  total?: number;
  success?: number;
  failed?: number;
  skipped?: number;
  timeout?: number;
  blocked?: number;
}

type ApprovalStrategy = 'approve' | 'reject' | 'none';

interface CaseConfig {
  readonly expectedSuccess: boolean;
  readonly expectedSummary: ExpectedSummary;
  readonly approvalStrategy: ApprovalStrategy;
  /** If set, abort the pipeline after this many ms via an external AbortSignal. */
  readonly signalCancelAfterMs?: number;
  /** Extra paths to remove during workspace cleanup (relative to workDir). */
  readonly extraClean?: readonly string[];
}

const CASE_CONFIGS: Record<CaseName, CaseConfig> = {
  '01-command-smoke': {
    expectedSuccess: true,
    expectedSummary: { total: 4, success: 4, failed: 0, skipped: 0, timeout: 0, blocked: 0 },
    approvalStrategy: 'approve',
  },
  '02-manual-ignore': {
    expectedSuccess: false,
    expectedSummary: { total: 3, success: 2, failed: 1, skipped: 0, blocked: 0 },
    approvalStrategy: 'approve',
  },
  '03-stopall-timeout': {
    expectedSuccess: false,
    expectedSummary: { total: 3, failed: 1, skipped: 1, timeout: 1, blocked: 0 },
    approvalStrategy: 'approve',
  },
  '04-pipeline-timeout': {
    expectedSuccess: false,
    expectedSummary: { total: 1, timeout: 1, success: 0, failed: 0 },
    approvalStrategy: 'approve',
  },
  '05-claude-haiku': {
    expectedSuccess: true,
    expectedSummary: { total: 2, success: 2, failed: 0 },
    approvalStrategy: 'approve',
  },
  '06-codex-plugin': {
    expectedSuccess: true,
    expectedSummary: { total: 2, success: 2, failed: 0 },
    approvalStrategy: 'approve',
  },
  '07-hook-gate-pipeline': {
    // pipeline_start hook blocks → all tasks stay idle (counted in total, rest all 0)
    expectedSuccess: false,
    expectedSummary: { total: 1, success: 0, failed: 0, skipped: 0, timeout: 0, blocked: 0 },
    approvalStrategy: 'approve',
  },
  '08-hook-gate-task': {
    // blocked_task: blocked | downstream: skipped | independent: success
    expectedSuccess: false,
    expectedSummary: { total: 3, blocked: 1, skipped: 1, success: 1, failed: 0, timeout: 0 },
    approvalStrategy: 'approve',
  },
  '09-skip-downstream': {
    // fail_first: failed | skipped_dep: skipped | skipped_transitive: skipped | independent: success
    expectedSuccess: false,
    expectedSummary: { total: 4, failed: 1, skipped: 2, success: 1, blocked: 0, timeout: 0 },
    approvalStrategy: 'approve',
  },
  '10-manual-reject': {
    // manual trigger auto-rejected → task becomes blocked
    expectedSuccess: false,
    expectedSummary: { total: 1, blocked: 1, success: 0, failed: 0, timeout: 0 },
    approvalStrategy: 'reject',
  },
  '11-manual-timeout': {
    // no approval → trigger times out after 1s → task becomes timeout
    expectedSuccess: false,
    expectedSummary: { total: 1, timeout: 1, success: 0, blocked: 0, failed: 0 },
    approvalStrategy: 'none',
  },
  '12-exit-code-variants': {
    // array_expect_match: success | nonzero_expect_miss: failed (completion gate)
    expectedSuccess: false,
    expectedSummary: { total: 2, success: 1, failed: 1, skipped: 0, blocked: 0 },
    approvalStrategy: 'approve',
  },
  '13-file-exists-variants': {
    expectedSuccess: true,
    expectedSummary: { total: 3, success: 3, failed: 0 },
    approvalStrategy: 'approve',
  },
  '14-file-trigger-exists': {
    // file already exists when trigger starts watching — resolves via ready-event check
    expectedSuccess: true,
    expectedSummary: { total: 2, success: 2, failed: 0 },
    approvalStrategy: 'approve',
  },
  '15-hook-array': {
    expectedSuccess: true,
    expectedSummary: { total: 1, success: 1, failed: 0 },
    approvalStrategy: 'approve',
  },
  '16-cwd-override': {
    // setup_subdir + write_in_subdir + verify_from_workdir
    expectedSuccess: true,
    expectedSummary: { total: 3, success: 3, failed: 0 },
    approvalStrategy: 'approve',
    extraClean: ['sub-workspace'],
  },
  '17-track-middlewares': {
    expectedSuccess: true,
    expectedSummary: { total: 2, success: 2, failed: 0 },
    approvalStrategy: 'approve',
  },
  '18-signal-cancel': {
    // both long tasks cancelled mid-run via external signal → both timeout
    expectedSuccess: false,
    expectedSummary: { total: 2, timeout: 2, success: 0, failed: 0 },
    approvalStrategy: 'approve',
    signalCancelAfterMs: 400,
  },
  '19-ignore-cross-track': {
    // fail_task (failed, ignored) → cross_dep (success, dep satisfied via cross-track ignore)
    expectedSuccess: false,
    expectedSummary: { total: 2, failed: 1, success: 1, skipped: 0, blocked: 0 },
    approvalStrategy: 'approve',
  },
  '20-track-cwd': {
    // create_dir + write_file (track cwd) + verify_from_parent
    expectedSuccess: true,
    expectedSummary: { total: 3, success: 3, failed: 0 },
    approvalStrategy: 'approve',
    extraClean: ['sub-workspace'],
  },
  '22-file-trigger-change': {
    // create + overwrite (writer track) + wait_change (reactor track)
    expectedSuccess: true,
    expectedSummary: { total: 3, success: 3, failed: 0 },
    approvalStrategy: 'approve',
  },
};

// ═══ Assertion Helpers ═══

let totalFails = 0;

function assert(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    console.error(`  FAIL  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    totalFails++;
  } else {
    console.log(`  pass  ${label}`);
  }
}

function assertSummary(caseName: string, result: EngineResult, cfg: CaseConfig): void {
  assert(`${caseName}: success`, result.success, cfg.expectedSuccess);
  const s = result.summary;
  const exp = cfg.expectedSummary;
  if (exp.total    !== undefined) assert(`${caseName}: total`,   s.total,   exp.total);
  if (exp.success  !== undefined) assert(`${caseName}: success_count`, s.success, exp.success);
  if (exp.failed   !== undefined) assert(`${caseName}: failed`,  s.failed,  exp.failed);
  if (exp.skipped  !== undefined) assert(`${caseName}: skipped`, s.skipped, exp.skipped);
  if (exp.timeout  !== undefined) assert(`${caseName}: timeout`, s.timeout, exp.timeout);
  if (exp.blocked  !== undefined) assert(`${caseName}: blocked`, s.blocked, exp.blocked);
}

// ═══ Workspace Cleanup ═══

async function cleanWorkspace(workDir: string, extraClean: readonly string[] = []): Promise<void> {
  await rm(resolve(workDir, '.tagma'), { recursive: true, force: true });
  await rm(resolve(workDir, '.tagma-tests', 'generated'), { recursive: true, force: true });
  await rm(resolve(workDir, '.tagma-tests', 'output'), { recursive: true, force: true });
  await rm(resolve(workDir, '.tagma-tests', 'hook-events.log'), { recursive: true, force: true });
  for (const extra of extraClean) {
    await rm(resolve(workDir, extra), { recursive: true, force: true });
  }
  await mkdir(resolve(workDir, '.tagma-tests'), { recursive: true });
}

// ═══ Approval Gateway Setup ═══

function makeGateway(strategy: ApprovalStrategy): InMemoryApprovalGateway {
  const gateway = new InMemoryApprovalGateway();

  if (strategy === 'approve' || strategy === 'reject') {
    gateway.subscribe((event) => {
      if (event.type === 'requested') {
        setTimeout(() => {
          if (strategy === 'approve') {
            gateway.resolve(event.request.id, {
              outcome: 'approved',
              choice: event.request.options[0] ?? 'approve',
              actor: 'tests/run-sample.ts',
            });
          } else {
            gateway.resolve(event.request.id, {
              outcome: 'rejected',
              choice: event.request.options[1] ?? 'reject',
              actor: 'tests/run-sample.ts',
              reason: 'auto-rejected by test runner',
            });
          }
        }, 20);
      }
    });
  }
  // strategy === 'none': don't subscribe → let trigger's own timeout fire

  return gateway;
}

// ═══ Single Case Runner ═══

async function runCase(name: CaseName): Promise<void> {
  const cfg = CASE_CONFIGS[name];
  const root = process.cwd();
  const yamlPath = resolve(root, 'tests', 'cases', `${name}.yaml`);
  const workDir = resolve(root, 'tests', 'workspaces', name);

  await cleanWorkspace(workDir, cfg.extraClean);

  const gateway = makeGateway(cfg.approvalStrategy);
  const yaml = await Bun.file(yamlPath).text();
  const config = await loadPipeline(yaml, workDir);

  console.log(`\n=== Running ${name} ===`);

  let result: EngineResult;

  if (cfg.signalCancelAfterMs !== undefined) {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      console.log(`  [signal-cancel] aborting after ${cfg.signalCancelAfterMs}ms`);
      ac.abort();
    }, cfg.signalCancelAfterMs);
    try {
      result = await runPipeline(config, workDir, { approvalGateway: gateway, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  } else {
    result = await runPipeline(config, workDir, { approvalGateway: gateway });
  }

  console.log(
    `[${name}] success=${result.success} total=${result.summary.total} ` +
    `ok=${result.summary.success} failed=${result.summary.failed} ` +
    `skipped=${result.summary.skipped} timeout=${result.summary.timeout} ` +
    `blocked=${result.summary.blocked}`,
  );
  console.log(`[${name}] logs: ${resolve(workDir, '.tagma', 'logs')}`);

  assertSummary(name, result, cfg);

  // ── Post-assertion side-effect checks ──
  if (name === '07-hook-gate-pipeline') {
    const forbidden = resolve(workDir, '.tagma-tests', 'generated', 'must-not-exist.txt');
    const exists = await Bun.file(forbidden).exists();
    assert(`${name}: must-not-exist.txt absent`, exists, false);
  }

  if (name === '15-hook-array') {
    const countFile = resolve(workDir, '.tagma-tests', 'generated', 'hook-count.txt');
    const exists = await Bun.file(countFile).exists();
    assert(`${name}: hook-count.txt created by second hook`, exists, true);
  }

  // ── 16-cwd-override: verify file landed in correct subdirectory with correct content ──
  if (name === '16-cwd-override') {
    const outFile = resolve(workDir, 'sub-workspace', 'output', 'from-sub.txt');
    const exists = await Bun.file(outFile).exists();
    assert(`${name}: from-sub.txt exists in sub-workspace/output`, exists, true);
    if (exists) {
      const content = (await Bun.file(outFile).text()).trim();
      assert(`${name}: from-sub.txt content`, content, 'CWD_OVERRIDE_OK');
    }
  }

  // ── 20-track-cwd: verify track-level cwd placed file correctly ──
  if (name === '20-track-cwd') {
    const outFile = resolve(workDir, 'sub-workspace', 'track-cwd-output.txt');
    const exists = await Bun.file(outFile).exists();
    assert(`${name}: track-cwd-output.txt exists in sub-workspace`, exists, true);
    if (exists) {
      const content = (await Bun.file(outFile).text()).trim();
      assert(`${name}: track-cwd-output.txt content`, content, 'TRACK_CWD_OK');
    }
  }

  // ── 18-signal-cancel: verify tasks were actually killed early (durationMs << 2000ms) ──
  if (name === '18-signal-cancel') {
    for (const key of ['long_tasks.long_a', 'long_tasks.long_b']) {
      const state = result.states.get(key);
      assert(`${name}: ${key} status is timeout`, state?.status, 'timeout');
      if (state?.result) {
        const tooLong = state.result.durationMs > 1500;
        assert(`${name}: ${key} killed early (durationMs <= 1500)`, tooLong, false);
      }
    }
  }

  // ── 19-ignore-cross-track: verify cross_dep produced its output file ──
  if (name === '19-ignore-cross-track') {
    const outFile = resolve(workDir, '.tagma-tests', 'generated', 'cross-ignore.txt');
    const exists = await Bun.file(outFile).exists();
    assert(`${name}: cross-ignore.txt exists`, exists, true);
    if (exists) {
      const content = (await Bun.file(outFile).text()).trim();
      assert(`${name}: cross-ignore.txt content`, content, 'CROSS_IGNORE_OK');
    }
    // Verify the failing task actually failed and the dependent task succeeded
    const failState = result.states.get('failing_track.fail_task');
    const depState = result.states.get('dependent_track.cross_dep');
    assert(`${name}: fail_task status`, failState?.status, 'failed');
    assert(`${name}: cross_dep status`, depState?.status, 'success');
  }

  // ── 22-file-trigger-change: verify content assertions ──
  if (name === '22-file-trigger-change') {
    // watched.txt should have final overwritten content
    const watchedFile = resolve(workDir, '.tagma-tests', 'generated', 'watched.txt');
    const watchedExists = await Bun.file(watchedFile).exists();
    assert(`${name}: watched.txt exists`, watchedExists, true);
    if (watchedExists) {
      const content = (await Bun.file(watchedFile).text()).trim();
      assert(`${name}: watched.txt final content is CHANGED`, content, 'CHANGED');
    }
    // reacted.txt should have been created by the reactor
    const reactedFile = resolve(workDir, '.tagma-tests', 'generated', 'reacted.txt');
    const reactedExists = await Bun.file(reactedFile).exists();
    assert(`${name}: reacted.txt exists`, reactedExists, true);
    if (reactedExists) {
      const content = (await Bun.file(reactedFile).text()).trim();
      assert(`${name}: reacted.txt content`, content, 'CHANGE_DETECTED');
    }
  }
}

// ═══ PipelineRunner + onEvent Smoke Test ═══

async function testPipelineRunner(): Promise<void> {
  console.log('\n=== PipelineRunner + onEvent smoke test ===');

  const root = process.cwd();
  const workDir = resolve(root, 'tests', 'workspaces', '_runner-smoke');
  await cleanWorkspace(workDir);

  const simpleYaml = `
pipeline:
  name: runner-smoke
  tracks:
    - id: main
      name: Main
      tasks:
        - id: step_a
          name: Step A
          command: bun ../../helpers/echo.ts RUNNER_A_OK
          completion:
            type: output_check
            check: bun ../../helpers/check-stdin-contains.ts RUNNER_A_OK

        - id: step_b
          name: Step B
          command: bun ../../helpers/echo.ts RUNNER_B_OK
          depends_on: [step_a]
          completion:
            type: output_check
            check: bun ../../helpers/check-stdin-contains.ts RUNNER_B_OK
`;

  const config = await loadPipeline(simpleYaml, workDir);

  // ── Events collection ──
  const events: string[] = [];

  const runner = new PipelineRunner(config, workDir);
  assert('runner: initial status', runner.status, 'idle');
  assert('runner: no runId before start', runner.runId, null);
  assert('runner: getStates null before start', runner.getStates(), null);

  const unsub = runner.subscribe((event) => {
    events.push(event.type);
    if (event.type === 'pipeline_start') {
      // getStates() should be populated immediately after pipeline_start
      const states = runner.getStates();
      assert('runner: getStates populated at pipeline_start', states !== null, true);
    }
  });

  const resultPromise = runner.start();

  // start() is idempotent — second call returns same Promise
  const resultPromise2 = runner.start();
  assert('runner: start() idempotent', resultPromise === resultPromise2, true);

  assert('runner: status is running after start', runner.status, 'running');

  const result = await resultPromise;

  unsub(); // unsubscribe

  assert('runner: final status done', runner.status, 'done');
  assert('runner: runId available', typeof runner.runId, 'string');
  assert('runner: result success', result.success, true);
  assert('runner: result total', result.summary.total, 2);
  assert('runner: result success count', result.summary.success, 2);

  // Verify getStates() reflects final state
  const finalStates = runner.getStates();
  assert('runner: getStates not null after run', finalStates !== null, true);
  if (finalStates) {
    assert('runner: step_a success', finalStates.get('main.step_a')?.status, 'success');
    assert('runner: step_b success', finalStates.get('main.step_b')?.status, 'success');
  }

  // Verify event sequence
  assert('runner: pipeline_start fired', events.includes('pipeline_start'), true);
  assert('runner: task_status_change fired', events.includes('task_status_change'), true);
  assert('runner: pipeline_end fired', events.includes('pipeline_end'), true);
  // pipeline_end must be last
  assert('runner: pipeline_end is last event', events[events.length - 1], 'pipeline_end');

  // ── Abort test ──
  console.log('\n--- PipelineRunner abort test ---');
  const abortWorkDir = resolve(root, 'tests', 'workspaces', '_runner-abort');
  await cleanWorkspace(abortWorkDir);

  const longYaml = `
pipeline:
  name: runner-abort
  timeout: 30s
  tracks:
    - id: main
      name: Main
      tasks:
        - id: long_sleep
          name: Long sleep
          command: bun ../../helpers/sleep.ts 2000
`;

  const longConfig = await loadPipeline(longYaml, abortWorkDir);
  const abortRunner = new PipelineRunner(longConfig, abortWorkDir);
  const abortResult = abortRunner.start();

  // Let it start, then abort after 300ms
  await new Promise(r => setTimeout(r, 300));
  abortRunner.abort('test abort');

  const abortRes = await abortResult;
  assert('runner abort: success=false', abortRes.success, false);
  assert('runner abort: status=aborted', abortRunner.status, 'aborted');
  assert('runner abort: task timed out', abortRes.summary.timeout, 1);
}

// ═══ Usage & Main ═══

function usage(): never {
  console.log(`Usage:
  bun tests/run-sample.ts --list
  bun tests/run-sample.ts --all
  bun tests/run-sample.ts --local          # all non-AI cases
  bun tests/run-sample.ts --ai             # AI cases only (05, 06, 17)
  bun tests/run-sample.ts --extras         # PipelineRunner + onEvent smoke
  bun tests/run-sample.ts <case> [cases...]

Local-only cases:
  01-command-smoke  02-manual-ignore  03-stopall-timeout  04-pipeline-timeout
  07-hook-gate-pipeline  08-hook-gate-task  09-skip-downstream
  10-manual-reject  11-manual-timeout  12-exit-code-variants
  13-file-exists-variants  14-file-trigger-exists  15-hook-array
  16-cwd-override  18-signal-cancel  19-ignore-cross-track  20-track-cwd

AI cases (require claude-code / codex):
  05-claude-haiku  06-codex-plugin  17-track-middlewares
`);
  process.exit(1);
}

const LOCAL_CASES: readonly CaseName[] = [
  '01-command-smoke', '02-manual-ignore', '03-stopall-timeout', '04-pipeline-timeout',
  '07-hook-gate-pipeline', '08-hook-gate-task', '09-skip-downstream',
  '10-manual-reject', '11-manual-timeout', '12-exit-code-variants',
  '13-file-exists-variants', '14-file-trigger-exists', '15-hook-array',
  '16-cwd-override', '18-signal-cancel',
  '19-ignore-cross-track', '20-track-cwd', '22-file-trigger-change',
];

const AI_CASES: readonly CaseName[] = [
  '05-claude-haiku', '06-codex-plugin', '17-track-middlewares',
];

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length === 0) usage();

  // Bootstrap built-ins once
  bootstrapBuiltins();

  if (args.includes('--list')) {
    console.log(CASES.join('\n'));
    return;
  }

  if (args.includes('--extras')) {
    await testPipelineRunner();
    if (totalFails > 0) {
      console.error(`\n${totalFails} assertion(s) FAILED`);
      process.exit(1);
    }
    console.log('\nAll extra tests passed.');
    return;
  }

  let selected: CaseName[];
  if (args.includes('--all')) {
    selected = [...CASES];
  } else if (args.includes('--local')) {
    selected = [...LOCAL_CASES];
  } else if (args.includes('--ai')) {
    selected = [...AI_CASES];
  } else {
    selected = args.filter(isCaseName);
    if (selected.length === 0) usage();
  }

  for (const name of selected) {
    await runCase(name);
  }

  console.log('\n── Assertion summary ──');
  if (totalFails > 0) {
    console.error(`${totalFails} assertion(s) FAILED`);
    process.exit(1);
  } else {
    console.log('All assertions passed.');
  }
}

await main();
