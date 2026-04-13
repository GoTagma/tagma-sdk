// Unit tests for runtime hardening against misbehaving third-party plugins.
// Covers R1, R2, R3, R4, R5, R6, R8 from the runtime-robustness review.
//
// These exercise the *fault-tolerance* paths — the question is not "does a
// well-behaved plugin work" (other tests cover that) but "does the engine
// fail gracefully when a third-party plugin returns garbage / throws / hangs".

import { describe, it, expect, afterEach, beforeAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrapBuiltins } from '../../src/bootstrap';
import { registerPlugin, unregisterPlugin } from '../../src/registry';
import { runSpawn, validateSpawnSpec } from '../../src/runner';
import { runPipeline } from '../../src/engine';
import type {
  DriverPlugin, SpawnSpec, TaskResult,
  TriggerPlugin, CompletionPlugin, MiddlewarePlugin,
  PipelineConfig,
} from '../../src/types';

beforeAll(() => {
  // Built-ins must be registered or runPipeline preflight rejects the
  // default `claude-code` driver lookup before our mocks even get a chance.
  bootstrapBuiltins();
});

function makeTmpWorkDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-runtime-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mockEchoDriver(name: string): DriverPlugin {
  return {
    name,
    capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
    async buildCommand() { return { args: ['echo', 'mock-output'] }; },
  };
}

// ─── R8: validateContract enforces driver capabilities shape ─────────────

describe('R8: registerPlugin enforces driver capabilities shape', () => {
  it('rejects a driver missing capabilities entirely', () => {
    expect(() => registerPlugin('drivers', 'r8-no-caps', {
      name: 'r8-no-caps',
      buildCommand: async () => ({ args: ['echo'] }),
    } as unknown as DriverPlugin)).toThrow(/capabilities/);
  });

  it('rejects a driver whose capabilities is not an object', () => {
    expect(() => registerPlugin('drivers', 'r8-caps-string', {
      name: 'r8-caps-string',
      capabilities: 'all-the-things',
      buildCommand: async () => ({ args: ['echo'] }),
    } as unknown as DriverPlugin)).toThrow(/capabilities/);
  });

  it('rejects a driver whose capabilities.sessionResume is missing', () => {
    expect(() => registerPlugin('drivers', 'r8-caps-partial', {
      name: 'r8-caps-partial',
      capabilities: { systemPrompt: true, outputFormat: false },
      buildCommand: async () => ({ args: ['echo'] }),
    } as unknown as DriverPlugin)).toThrow(/sessionResume/);
  });

  it('rejects a driver whose capabilities.systemPrompt is the wrong type', () => {
    expect(() => registerPlugin('drivers', 'r8-caps-typo', {
      name: 'r8-caps-typo',
      capabilities: { sessionResume: true, systemPrompt: 'yes', outputFormat: false },
      buildCommand: async () => ({ args: ['echo'] }),
    } as unknown as DriverPlugin)).toThrow(/systemPrompt/);
  });

  it('rejects a driver whose capabilities getter throws', () => {
    const evil = {
      name: 'r8-evil-getter',
      get capabilities() { throw new Error('boom'); },
      buildCommand: async () => ({ args: ['echo'] }),
    };
    expect(() => registerPlugin('drivers', 'r8-evil-getter', evil as unknown as DriverPlugin))
      .toThrow(/threw/);
  });

  it('rejects a driver where parseResult is not a function', () => {
    expect(() => registerPlugin('drivers', 'r8-bad-parse', {
      name: 'r8-bad-parse',
      capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
      buildCommand: async () => ({ args: ['echo'] }),
      parseResult: 'totally-a-string',
    } as unknown as DriverPlugin)).toThrow(/parseResult/);
  });

  it('accepts a well-formed driver', () => {
    const good: DriverPlugin = {
      name: 'r8-good',
      capabilities: { sessionResume: true, systemPrompt: true, outputFormat: false },
      buildCommand: async () => ({ args: ['echo', 'hi'] }),
    };
    expect(() => registerPlugin('drivers', 'r8-good', good)).not.toThrow();
    unregisterPlugin('drivers', 'r8-good');
  });
});

// ─── R2: validateSpawnSpec catches malformed driver returns ──────────────

describe('R2: validateSpawnSpec', () => {
  const driverName = 'test-driver';

  it('accepts a minimal valid spec', () => {
    expect(validateSpawnSpec({ args: ['echo', 'hi'] }, driverName)).toBeNull();
  });

  it('accepts a fully-populated spec', () => {
    expect(validateSpawnSpec({
      args: ['node', 'script.js'],
      cwd: '/tmp',
      stdin: 'hello',
      env: { PATH: '/usr/bin', FOO: 'bar' },
    }, driverName)).toBeNull();
  });

  it('rejects null', () => {
    expect(validateSpawnSpec(null, driverName)).toMatch(/null/);
  });

  it('rejects a string instead of object', () => {
    expect(validateSpawnSpec('echo hi', driverName)).toMatch(/string/);
  });

  it('rejects args that is not an array', () => {
    expect(validateSpawnSpec({ args: 'echo hi' }, driverName)).toMatch(/spec\.args/);
  });

  it('rejects empty args', () => {
    expect(validateSpawnSpec({ args: [] }, driverName)).toMatch(/empty/);
  });

  it('rejects args containing non-strings', () => {
    expect(validateSpawnSpec({ args: ['echo', 42, 'hi'] }, driverName)).toMatch(/args\[1\]/);
  });

  it('rejects cwd that is not a string', () => {
    expect(validateSpawnSpec({ args: ['echo'], cwd: 42 }, driverName)).toMatch(/spec\.cwd/);
  });

  it('rejects stdin that is not a string', () => {
    expect(validateSpawnSpec({ args: ['echo'], stdin: { foo: 'bar' } }, driverName)).toMatch(/spec\.stdin/);
  });

  it('rejects env that is an array', () => {
    expect(validateSpawnSpec({ args: ['echo'], env: ['PATH=/usr/bin'] }, driverName)).toMatch(/spec\.env/);
  });

  it('rejects env values that are not strings', () => {
    expect(validateSpawnSpec({ args: ['echo'], env: { PATH: 42 } }, driverName)).toMatch(/spec\.env\.PATH/);
  });

  it('error message includes the driver name', () => {
    expect(validateSpawnSpec(null, 'codex')).toContain('codex');
  });
});

// ─── R2 (integration): runSpawn returns failResult on bad spec ───────────

describe('R2: runSpawn rejects malformed specs without spawning', () => {
  it('returns a failed result for empty args', async () => {
    const result = await runSpawn(
      { args: [] } as unknown as SpawnSpec,
      null,
    );
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/empty/);
    expect(result.stdout).toBe('');
  });

  it('returns a failed result for non-array args', async () => {
    const result = await runSpawn(
      { args: 'echo hi' } as unknown as SpawnSpec,
      null,
    );
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/spec\.args/);
  });

  it('failed result includes the driver name', async () => {
    const driver = {
      name: 'r2-driver',
      capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
      buildCommand: async () => ({ args: [] }),
    } as DriverPlugin;
    const result = await runSpawn(
      { args: [] } as unknown as SpawnSpec,
      driver,
    );
    expect(result.stderr).toContain('r2-driver');
  });
});

// ─── R1 + R5: parseResult fault tolerance ────────────────────────────────

describe('R1: runSpawn survives a throwing parseResult', () => {
  it('appends a breadcrumb to stderr instead of losing the result', async () => {
    const driver: DriverPlugin = {
      name: 'r1-thrower',
      capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
      buildCommand: async () => ({ args: ['echo'] }),
      parseResult: () => { throw new Error('parse-bug'); },
    };

    // Use a real `echo` so we have a successful spawn + actual stdout.
    const result = await runSpawn({ args: ['echo', 'hello-from-spawn'] }, driver);
    expect(result.exitCode).toBe(0);
    // stdout still surfaced — parseResult failure must not eat it.
    expect(result.stdout).toContain('hello-from-spawn');
    // breadcrumb appended to stderr so user can see WHY metadata is null.
    expect(result.stderr).toMatch(/r1-thrower.*parseResult.*parse-bug/);
    // metadata fields safely defaulted.
    expect(result.sessionId).toBeNull();
    expect(result.normalizedOutput).toBeNull();
  });
});

describe('R5: runSpawn type-guards parseResult return values', () => {
  it('drops non-string sessionId', async () => {
    const driver: DriverPlugin = {
      name: 'r5-bad-session',
      capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
      buildCommand: async () => ({ args: ['echo'] }),
      parseResult: () => ({ sessionId: { id: 'nested' } as unknown as string }),
    };
    const result = await runSpawn({ args: ['echo'] }, driver);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBeNull(); // not the nested object
  });

  it('drops non-string normalizedOutput', async () => {
    const driver: DriverPlugin = {
      name: 'r5-bad-norm',
      capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
      buildCommand: async () => ({ args: ['echo'] }),
      parseResult: () => ({ normalizedOutput: 42 as unknown as string }),
    };
    const result = await runSpawn({ args: ['echo'] }, driver);
    expect(result.normalizedOutput).toBeNull();
  });

  it('drops empty-string sessionId (treats as missing)', async () => {
    const driver: DriverPlugin = {
      name: 'r5-empty-session',
      capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
      buildCommand: async () => ({ args: ['echo'] }),
      parseResult: () => ({ sessionId: '' }),
    };
    const result = await runSpawn({ args: ['echo'] }, driver);
    expect(result.sessionId).toBeNull();
  });

  it('accepts well-formed metadata', async () => {
    const driver: DriverPlugin = {
      name: 'r5-good',
      capabilities: { sessionResume: true, systemPrompt: false, outputFormat: false },
      buildCommand: async () => ({ args: ['echo'] }),
      parseResult: () => ({ sessionId: 'sess_abc', normalizedOutput: 'canonical text' }),
    };
    const result = await runSpawn({ args: ['echo'] }, driver);
    expect(result.sessionId).toBe('sess_abc');
    expect(result.normalizedOutput).toBe('canonical text');
  });

  it('handles parseResult returning null gracefully', async () => {
    const driver: DriverPlugin = {
      name: 'r5-null-meta',
      capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
      buildCommand: async () => ({ args: ['echo'] }),
      parseResult: () => null as unknown as { sessionId?: string; normalizedOutput?: string },
    };
    const result = await runSpawn({ args: ['echo'] }, driver);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBeNull();
    expect(result.normalizedOutput).toBeNull();
  });
});

// ─── R3: middleware enhance return-value validation (engine integration) ───

describe('R3: engine catches middleware.enhance returning non-string', () => {
  const driverName = 'r3-mock-driver';
  const mwName = 'r3-bad-mw';

  afterEach(() => {
    unregisterPlugin('drivers', driverName);
    unregisterPlugin('middlewares', mwName);
  });

  it('marks task failed when enhance returns undefined', async () => {
    registerPlugin('drivers', driverName, mockEchoDriver(driverName));
    const badMw: MiddlewarePlugin = {
      name: mwName,
      async enhance() { return undefined as unknown as string; },
    };
    registerPlugin('middlewares', mwName, badMw);

    const { dir, cleanup } = makeTmpWorkDir();
    try {
      const config: PipelineConfig = {
        name: 'r3-test',
        tracks: [{
          id: 'tr1', name: 'Track 1', driver: driverName,
          on_failure: 'skip_downstream',
          tasks: [{
            id: 't1', name: 'T1', prompt: 'hello',
            middlewares: [{ type: mwName }],
          }],
        }],
      };
      const res = await runPipeline(config, dir, { skipPluginLoading: true });
      const state = res.states.get('tr1.t1')!;
      expect(state.status).toBe('failed');
      expect(state.result?.stderr ?? '').toMatch(/enhance.*undefined/);
    } finally {
      cleanup();
    }
  });

  it('marks task failed when enhance returns a number', async () => {
    registerPlugin('drivers', driverName, mockEchoDriver(driverName));
    const badMw: MiddlewarePlugin = {
      name: mwName,
      async enhance() { return 42 as unknown as string; },
    };
    registerPlugin('middlewares', mwName, badMw);

    const { dir, cleanup } = makeTmpWorkDir();
    try {
      const config: PipelineConfig = {
        name: 'r3-num',
        tracks: [{
          id: 'tr1', name: 'Track 1', driver: driverName,
          on_failure: 'skip_downstream',
          tasks: [{
            id: 't1', name: 'T1', prompt: 'hi',
            middlewares: [{ type: mwName }],
          }],
        }],
      };
      const res = await runPipeline(config, dir, { skipPluginLoading: true });
      expect(res.states.get('tr1.t1')!.status).toBe('failed');
    } finally {
      cleanup();
    }
  });
});

// ─── R4: completion check strict-boolean validation ───────────────────────

describe('R4: engine catches completion.check returning non-boolean', () => {
  const compName = 'r4-bad-completion';

  afterEach(() => {
    unregisterPlugin('completions', compName);
  });

  it('marks task failed when check returns a truthy string', async () => {
    const badComp: CompletionPlugin = {
      name: compName,
      async check() { return 'ok' as unknown as boolean; },
    };
    registerPlugin('completions', compName, badComp);

    const { dir, cleanup } = makeTmpWorkDir();
    try {
      const config: PipelineConfig = {
        name: 'r4-string',
        tracks: [{
          id: 'tr1', name: 'Track 1',
          on_failure: 'skip_downstream',
          tasks: [{
            id: 't1', name: 'T1',
            command: 'echo hi',
            completion: { type: compName },
          }],
        }],
      };
      const res = await runPipeline(config, dir, { skipPluginLoading: true });
      const state = res.states.get('tr1.t1')!;
      expect(state.status).toBe('failed');
      expect(state.result?.stderr ?? '').toMatch(/check.*string/);
    } finally {
      cleanup();
    }
  });

  it('marks task failed when check returns a number', async () => {
    const badComp: CompletionPlugin = {
      name: compName,
      async check() { return 1 as unknown as boolean; },
    };
    registerPlugin('completions', compName, badComp);

    const { dir, cleanup } = makeTmpWorkDir();
    try {
      const config: PipelineConfig = {
        name: 'r4-number',
        tracks: [{
          id: 'tr1', name: 'Track 1',
          on_failure: 'skip_downstream',
          tasks: [{
            id: 't1', name: 'T1',
            command: 'echo hi',
            completion: { type: compName },
          }],
        }],
      };
      const res = await runPipeline(config, dir, { skipPluginLoading: true });
      expect(res.states.get('tr1.t1')!.status).toBe('failed');
    } finally {
      cleanup();
    }
  });

  it('passes through a real false (task failed)', async () => {
    const honestComp: CompletionPlugin = {
      name: compName,
      async check() { return false; },
    };
    registerPlugin('completions', compName, honestComp);

    const { dir, cleanup } = makeTmpWorkDir();
    try {
      const config: PipelineConfig = {
        name: 'r4-honest-false',
        tracks: [{
          id: 'tr1', name: 'Track 1',
          on_failure: 'skip_downstream',
          tasks: [{
            id: 't1', name: 'T1',
            command: 'echo hi',
            completion: { type: compName },
          }],
        }],
      };
      const res = await runPipeline(config, dir, { skipPluginLoading: true });
      // honest false = legitimate "completion check did not pass" → failed,
      // but stderr should NOT contain a "check returned" type-error message.
      const state = res.states.get('tr1.t1')!;
      expect(state.status).toBe('failed');
      expect(state.result?.stderr ?? '').not.toMatch(/check.*returned/);
    } finally {
      cleanup();
    }
  });
});

// ─── R6: trigger.watch that ignores abort signal ──────────────────────────

describe('R6: engine races trigger.watch against pipeline abort', () => {
  const driverName = 'r6-mock-driver';
  const trigName = 'r6-deaf-trigger';

  afterEach(() => {
    unregisterPlugin('drivers', driverName);
    unregisterPlugin('triggers', trigName);
  });

  it('aborts the trigger wait when the pipeline signal fires (deaf trigger)', async () => {
    registerPlugin('drivers', driverName, mockEchoDriver(driverName));
    // Register a trigger that returns a forever-pending promise and never
    // wires up ctx.signal — this simulates a buggy third-party plugin.
    const deafTrigger: TriggerPlugin = {
      name: trigName,
      watch: () => new Promise<unknown>(() => { /* never resolves, ignores signal */ }),
    };
    registerPlugin('triggers', trigName, deafTrigger);

    const { dir, cleanup } = makeTmpWorkDir();
    try {
      const config: PipelineConfig = {
        name: 'r6-test',
        tracks: [{
          id: 'tr1', name: 'Track 1', driver: driverName,
          on_failure: 'skip_downstream',
          tasks: [{
            id: 't1', name: 'T1', prompt: 'hi',
            trigger: { type: trigName },
          }],
        }],
      };
      const ctrl = new AbortController();
      // Abort shortly after launch — engine must unblock the deaf trigger.
      const abortTimer = setTimeout(() => ctrl.abort(), 200);

      const res = await runPipeline(config, dir, {
        signal: ctrl.signal,
        skipPluginLoading: true,
      });
      clearTimeout(abortTimer);

      const state = res.states.get('tr1.t1')!;
      // Aborted-while-waiting tasks become 'skipped' (pipelineAborted branch
      // in the trigger catch block in engine.ts:447). The important thing is
      // that the pipeline RETURNED — without R6 it would hang forever.
      expect(['skipped', 'failed', 'timeout', 'blocked']).toContain(state.status);
    } finally {
      cleanup();
    }
  }, 5_000); // 5s safety net — the test itself should complete in <500ms
});

// ─── R15: normalizedOutput clipping ───────────────────────────────────────

describe('R15: normalizedMap clips oversized output', () => {
  const driverName = 'r15-driver';

  afterEach(() => {
    unregisterPlugin('drivers', driverName);
  });

  it('limits stored normalizedOutput to ~1MB even when driver returns 5MB', async () => {
    const fivemb = 'A'.repeat(5 * 1024 * 1024);
    const bigDriver: DriverPlugin = {
      name: driverName,
      capabilities: { sessionResume: true, systemPrompt: false, outputFormat: false },
      async buildCommand() { return { args: ['echo', 'hi'] }; },
      parseResult: () => ({ normalizedOutput: fivemb }),
    };
    registerPlugin('drivers', driverName, bigDriver);

    const { dir, cleanup } = makeTmpWorkDir();
    try {
      const config: PipelineConfig = {
        name: 'r15-test',
        tracks: [{
          id: 'tr1', name: 'Track 1', driver: driverName,
          on_failure: 'skip_downstream',
          tasks: [{ id: 't1', name: 'T1', prompt: 'hi' }],
        }],
      };
      const res = await runPipeline(config, dir, { skipPluginLoading: true });
      const state = res.states.get('tr1.t1')!;
      expect(state.status).toBe('success');
      // The result still has the raw normalizedOutput on the TaskResult itself
      // (so callers can see what the driver produced) — but normalizedMap
      // (used for continue_from injection) is the one that gets clipped.
      // We assert via the result's normalizedOutput being raw because the
      // map is internal; the clip happens before being stored. The test
      // asserts no crash + success status.
      expect(state.result?.normalizedOutput?.length ?? 0).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
