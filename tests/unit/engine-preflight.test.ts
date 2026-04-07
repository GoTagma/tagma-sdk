import { describe, it, expect, beforeAll } from 'bun:test';
import { bootstrapBuiltins, runPipeline } from '../../src/sdk';
import type { PipelineConfig } from '../../src/sdk';

// bootstrapBuiltins is idempotent — registers built-in plugins (claude-code, etc.)
// so that the driver-not-registered path only fires for truly unknown drivers.
beforeAll(() => {
  bootstrapBuiltins();
});

// ═══ Preflight error aggregation (src/engine.ts:85-87) ═══
//
// runPipeline throws before any I/O (Logger is created after preflight),
// so these tests don't write files to disk.

describe('runPipeline — preflight validation', () => {
  it('throws "Preflight validation failed" for an unregistered driver', async () => {
    const config: PipelineConfig = {
      name: 'preflight-bad-driver',
      tracks: [{
        id: 'tr1',
        name: 'Track 1',
        driver: 'nonexistent-driver',
        on_failure: 'skip_downstream',
        tasks: [{ id: 'task-1', name: 'T1', prompt: 'Do something' }],
      }],
    };

    await expect(runPipeline(config, '/tmp')).rejects.toThrow(
      'Preflight validation failed',
    );
  });

  it('aggregates multiple driver errors into a single throw', async () => {
    const config: PipelineConfig = {
      name: 'preflight-multi-error',
      tracks: [{
        id: 'tr1',
        name: 'Track 1',
        on_failure: 'skip_downstream',
        tasks: [
          { id: 'task-1', name: 'T1', prompt: 'A', driver: 'bad-driver-a' },
          { id: 'task-2', name: 'T2', prompt: 'B', driver: 'bad-driver-b' },
        ],
      }],
    };

    let caught: Error | undefined;
    try {
      await runPipeline(config, '/tmp');
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain('bad-driver-a');
    expect(caught!.message).toContain('bad-driver-b');
  });

  it('throws for an unregistered trigger type', async () => {
    const config: PipelineConfig = {
      name: 'preflight-bad-trigger',
      tracks: [{
        id: 'tr1',
        name: 'Track 1',
        on_failure: 'skip_downstream',
        tasks: [{
          id: 'task-1',
          name: 'T1',
          command: 'echo hello',
          trigger: { type: 'nonexistent-trigger', path: '/tmp/x' },
        }],
      }],
    };

    await expect(runPipeline(config, '/tmp')).rejects.toThrow(
      'nonexistent-trigger',
    );
  });

  it('throws for an unregistered completion type', async () => {
    const config: PipelineConfig = {
      name: 'preflight-bad-completion',
      tracks: [{
        id: 'tr1',
        name: 'Track 1',
        on_failure: 'skip_downstream',
        tasks: [{
          id: 'task-1',
          name: 'T1',
          command: 'echo hello',
          completion: { type: 'nonexistent-completion' },
        }],
      }],
    };

    await expect(runPipeline(config, '/tmp')).rejects.toThrow(
      'nonexistent-completion',
    );
  });
});

// ═══ Remaining engine failure-branch gaps (integration-level) ═══
//
// The following branches from engine.ts are NOT covered by unit tests because
// they require a full pipeline execution with real subprocesses or file watchers:
//
//   • Trigger plugin exception → task status 'failed' (src/engine.ts:397)
//     Requires a trigger plugin that throws a non-timeout, non-abort error.
//
//   • Log rotation via maxLogRuns (src/engine.ts:708)
//     Requires multiple completed pipeline runs that actually write log dirs.
//
// These are suitable for addition to the integration harness (tests/run-sample.ts)
// as dedicated YAML cases if deterministic coverage of those paths is required.
