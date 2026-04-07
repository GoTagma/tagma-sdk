import { describe, it, expect } from 'bun:test';
import OpenCodeDriver from '../../plugins/opencode-driver/src/index';
import type { TaskConfig, TrackConfig, DriverContext } from '../../src/types';

// ═══ Fixtures ═══

function makeTask(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    id: 'test_task',
    name: 'Test Task',
    prompt: 'Say hello',
    model_tier: 'medium',
    permissions: { read: true, write: false, execute: false },
    driver: 'opencode',
    cwd: '/tmp/test-workdir',
    ...overrides,
  };
}

function makeTrack(overrides: Partial<TrackConfig> = {}): TrackConfig {
  return {
    id: 'test_track',
    name: 'Test Track',
    model_tier: 'medium',
    permissions: { read: true, write: false, execute: false },
    driver: 'opencode',
    cwd: '/tmp/test-workdir',
    on_failure: 'skip_downstream',
    tasks: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<DriverContext> = {}): DriverContext {
  return {
    sessionMap: new Map(),
    outputMap: new Map(),
    normalizedMap: new Map(),
    workDir: '/tmp/test-workdir',
    ...overrides,
  };
}

function findArg(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// ═══ OpenCodeDriver — model resolution ═══

describe('OpenCodeDriver — model resolution', () => {
  it('all tiers map to opencode/big-pickle', async () => {
    for (const tier of ['low', 'medium', 'high']) {
      const spec = await OpenCodeDriver.buildCommand(
        makeTask({ model_tier: tier }), makeTrack(), makeCtx(),
      );
      expect(findArg(spec.args, '--model')).toBe('opencode/big-pickle');
    }
  });

  it('falls back to track model_tier when task has none', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      makeTask({ model_tier: undefined }),
      makeTrack({ model_tier: 'high' }),
      makeCtx(),
    );
    expect(findArg(spec.args, '--model')).toBe('opencode/big-pickle');
  });

  it('unknown tier falls back to opencode/big-pickle', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      makeTask({ model_tier: 'ultra' }), makeTrack(), makeCtx(),
    );
    expect(findArg(spec.args, '--model')).toBe('opencode/big-pickle');
  });
});

// ═══ OpenCodeDriver — buildCommand basics ═══

describe('OpenCodeDriver.buildCommand — basics', () => {
  it('generates "opencode run" as the command', async () => {
    const spec = await OpenCodeDriver.buildCommand(makeTask(), makeTrack(), makeCtx());
    expect(spec.args[0]).toBe('opencode');
    expect(spec.args[1]).toBe('run');
  });

  it('includes --format json', async () => {
    const spec = await OpenCodeDriver.buildCommand(makeTask(), makeTrack(), makeCtx());
    expect(findArg(spec.args, '--format')).toBe('json');
  });

  it('places prompt after -- separator', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      makeTask({ prompt: 'Do the thing' }), makeTrack(), makeCtx(),
    );
    const dashDashIdx = spec.args.indexOf('--');
    expect(dashDashIdx).toBeGreaterThan(-1);
    expect(spec.args[dashDashIdx + 1]).toBe('Do the thing');
  });

  it('uses task.cwd as spawn cwd', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      makeTask({ cwd: '/tmp/custom-cwd' }), makeTrack(), makeCtx(),
    );
    expect(spec.cwd).toBe('/tmp/custom-cwd');
  });

  it('falls back to ctx.workDir when task.cwd is not set', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      makeTask({ cwd: undefined }),
      makeTrack(),
      makeCtx({ workDir: '/tmp/fallback' }),
    );
    expect(spec.cwd).toBe('/tmp/fallback');
  });
});

// ═══ OpenCodeDriver — agent_profile ═══

describe('OpenCodeDriver.buildCommand — agent_profile', () => {
  it('task agent_profile is prepended to the prompt with [Role]/[Task] structure', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      makeTask({ prompt: 'My task', agent_profile: 'You are a coder.' }),
      makeTrack(),
      makeCtx(),
    );
    const dashDashIdx = spec.args.indexOf('--');
    const fullPrompt = spec.args[dashDashIdx + 1] as string;
    expect(fullPrompt).toContain('[Role]');
    expect(fullPrompt).toContain('You are a coder.');
    expect(fullPrompt).toContain('[Task]');
    expect(fullPrompt).toContain('My task');
  });

  it('falls back to track agent_profile when task has none', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      makeTask({ agent_profile: undefined }),
      makeTrack({ agent_profile: 'Track profile' }),
      makeCtx(),
    );
    const dashDashIdx = spec.args.indexOf('--');
    const fullPrompt = spec.args[dashDashIdx + 1] as string;
    expect(fullPrompt).toContain('Track profile');
  });

  it('no agent_profile → prompt is passed as-is', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      makeTask({ prompt: 'Just the prompt', agent_profile: undefined }),
      makeTrack({ agent_profile: undefined }),
      makeCtx(),
    );
    const dashDashIdx = spec.args.indexOf('--');
    expect(spec.args[dashDashIdx + 1]).toBe('Just the prompt');
  });
});

// ═══ OpenCodeDriver — continue_from / session resume ═══

describe('OpenCodeDriver.buildCommand — continue_from', () => {
  it('adds --session with session ID when available', async () => {
    const sessionMap = new Map([['upstream', 'sess-abc']]);
    const spec = await OpenCodeDriver.buildCommand(
      makeTask({ continue_from: 'upstream' }),
      makeTrack(),
      makeCtx({ sessionMap }),
    );
    expect(findArg(spec.args, '--session')).toBe('sess-abc');
  });

  it('no --session when session ID is missing', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      makeTask({ continue_from: 'upstream' }),
      makeTrack(),
      makeCtx(), // empty sessionMap
    );
    expect(spec.args).not.toContain('--session');
  });

  it('injects normalizedMap output into prompt when no session ID', async () => {
    const normalizedMap = new Map([['upstream', 'the prior output']]);
    const spec = await OpenCodeDriver.buildCommand(
      makeTask({ prompt: 'Next task', continue_from: 'upstream' }),
      makeTrack(),
      makeCtx({ normalizedMap }),
    );
    const dashDashIdx = spec.args.indexOf('--');
    const fullPrompt = spec.args[dashDashIdx + 1] as string;
    expect(fullPrompt).toContain('[Previous Output]');
    expect(fullPrompt).toContain('the prior output');
    expect(fullPrompt).toContain('[Current Task]');
    expect(fullPrompt).toContain('Next task');
  });

  it('no --session when continue_from is undefined', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      makeTask({ continue_from: undefined }),
      makeTrack(),
      makeCtx(),
    );
    expect(spec.args).not.toContain('--session');
  });
});

// ═══ OpenCodeDriver.parseResult ═══

describe('OpenCodeDriver.parseResult', () => {
  it('extracts result field from JSON stdout', () => {
    const meta = OpenCodeDriver.parseResult!(
      JSON.stringify({ result: 'The answer', session_id: 'sess-1' }),
      '',
    );
    expect(meta.normalizedOutput).toBe('The answer');
    expect(meta.sessionId).toBe('sess-1');
  });

  it('falls back to text field when result is absent', () => {
    const meta = OpenCodeDriver.parseResult!(
      JSON.stringify({ text: 'Text value' }),
      '',
    );
    expect(meta.normalizedOutput).toBe('Text value');
  });

  it('falls back to content field when result and text are absent', () => {
    const meta = OpenCodeDriver.parseResult!(
      JSON.stringify({ content: 'Content value' }),
      '',
    );
    expect(meta.normalizedOutput).toBe('Content value');
  });

  it('returns undefined normalizedOutput for error type responses', () => {
    const meta = OpenCodeDriver.parseResult!(
      JSON.stringify({ type: 'error', message: 'something failed' }),
      '',
    );
    expect(meta.normalizedOutput).toBeUndefined();
  });

  it('falls back to raw stdout when JSON is invalid', () => {
    const meta = OpenCodeDriver.parseResult!('plain text output', '');
    expect(meta.normalizedOutput).toBe('plain text output');
  });

  it('sessionId prefers session_id over sessionId field', () => {
    const meta = OpenCodeDriver.parseResult!(
      JSON.stringify({ result: 'R', session_id: 's1', sessionId: 's2' }),
      '',
    );
    expect(meta.sessionId).toBe('s1');
  });

  it('falls back to sessionId field when session_id is absent', () => {
    const meta = OpenCodeDriver.parseResult!(
      JSON.stringify({ result: 'R', sessionId: 's2' }),
      '',
    );
    expect(meta.sessionId).toBe('s2');
  });
});
