import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ClaudeCodeDriver } from '../../src/drivers/claude-code';
import { StaticContextMiddleware } from '../../src/middlewares/static-context';
import type { TaskConfig, TrackConfig, DriverContext, MiddlewareContext } from '../../src/types';

// ═══ Fixtures ═══

const PERMS_RO = { read: true, write: false, execute: false } as const;
const PERMS_RW = { read: true, write: true, execute: false } as const;
const PERMS_FULL = { read: true, write: true, execute: true } as const;

function makeTask(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    id: 'test_task',
    name: 'Test Task',
    prompt: 'Say hello',
    model_tier: 'medium',
    permissions: PERMS_RO,
    driver: 'claude-code',
    cwd: '/tmp/test-workdir',
    ...overrides,
  };
}

function makeTrack(overrides: Partial<TrackConfig> = {}): TrackConfig {
  return {
    id: 'test_track',
    name: 'Test Track',
    model_tier: 'medium',
    permissions: PERMS_RO,
    driver: 'claude-code',
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

// ═══ ClaudeCodeDriver — model resolution ═══

describe('ClaudeCodeDriver.buildCommand — model resolution', () => {
  it('model_tier: low → --model haiku', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ model_tier: 'low' }), makeTrack(), makeCtx(),
    );
    expect(findArg(spec.args, '--model')).toBe('haiku');
  });

  it('model_tier: medium → --model sonnet', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ model_tier: 'medium' }), makeTrack(), makeCtx(),
    );
    expect(findArg(spec.args, '--model')).toBe('sonnet');
  });

  it('model_tier: high → --model opus', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ model_tier: 'high' }), makeTrack(), makeCtx(),
    );
    expect(findArg(spec.args, '--model')).toBe('opus');
  });

  it('falls back to track model_tier when task has none', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ model_tier: undefined }),
      makeTrack({ model_tier: 'low' }),
      makeCtx(),
    );
    expect(findArg(spec.args, '--model')).toBe('haiku');
  });

  it('task model_tier takes precedence over track', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ model_tier: 'high' }),
      makeTrack({ model_tier: 'low' }),
      makeCtx(),
    );
    expect(findArg(spec.args, '--model')).toBe('opus');
  });
});

// ═══ ClaudeCodeDriver — permissions / tools ═══

describe('ClaudeCodeDriver.buildCommand — permissions mapping', () => {
  it('read-only → Grep,Glob,Read + dontAsk', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ permissions: PERMS_RO }), makeTrack(), makeCtx(),
    );
    expect(findArg(spec.args, '--allowedTools')).toBe('Grep,Glob,Read');
    expect(findArg(spec.args, '--permission-mode')).toBe('dontAsk');
  });

  it('read+write → adds Edit,Write + dontAsk', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ permissions: PERMS_RW }), makeTrack(), makeCtx(),
    );
    const tools = findArg(spec.args, '--allowedTools')!;
    expect(tools).toContain('Read');
    expect(tools).toContain('Edit');
    expect(tools).toContain('Write');
    expect(tools).not.toContain('Bash');
    expect(findArg(spec.args, '--permission-mode')).toBe('dontAsk');
  });

  it('full permissions → adds Bash + bypassPermissions', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ permissions: PERMS_FULL }), makeTrack(), makeCtx(),
    );
    const tools = findArg(spec.args, '--allowedTools')!;
    expect(tools).toContain('Bash');
    expect(findArg(spec.args, '--permission-mode')).toBe('bypassPermissions');
  });
});

// ═══ ClaudeCodeDriver — prompt ═══

describe('ClaudeCodeDriver.buildCommand — prompt delivery', () => {
  it('prompt is passed via stdin (not as -p arg value) to avoid Windows cmd.exe newline issues', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ prompt: 'Test prompt content' }), makeTrack(), makeCtx(),
    );
    // -p flag is present but without a value (prompt goes via stdin)
    expect(spec.args).toContain('-p');
    expect(spec.stdin).toBe('Test prompt content');
  });
});

// ═══ ClaudeCodeDriver — agent_profile ═══

describe('ClaudeCodeDriver.buildCommand — agent_profile', () => {
  it('task agent_profile → --append-system-prompt', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ agent_profile: 'You are a helpful assistant.' }),
      makeTrack(),
      makeCtx(),
    );
    expect(findArg(spec.args, '--append-system-prompt')).toBe('You are a helpful assistant.');
  });

  it('falls back to track agent_profile when task has none', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ agent_profile: undefined }),
      makeTrack({ agent_profile: 'Track profile here' }),
      makeCtx(),
    );
    expect(findArg(spec.args, '--append-system-prompt')).toBe('Track profile here');
  });

  it('task agent_profile overrides track', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ agent_profile: 'Task wins' }),
      makeTrack({ agent_profile: 'Track loses' }),
      makeCtx(),
    );
    expect(findArg(spec.args, '--append-system-prompt')).toBe('Task wins');
  });

  it('no agent_profile → no --append-system-prompt flag', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ agent_profile: undefined }),
      makeTrack({ agent_profile: undefined }),
      makeCtx(),
    );
    expect(spec.args).not.toContain('--append-system-prompt');
  });
});

// ═══ ClaudeCodeDriver — continue_from / session resume ═══

describe('ClaudeCodeDriver.buildCommand — continue_from', () => {
  it('adds --resume with session ID when available', async () => {
    const sessionMap = new Map([['upstream', 'session-abc-123']]);
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ continue_from: 'upstream' }),
      makeTrack(),
      makeCtx({ sessionMap }),
    );
    expect(findArg(spec.args, '--resume')).toBe('session-abc-123');
  });

  it('no --resume when session ID is missing', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ continue_from: 'upstream' }),
      makeTrack(),
      makeCtx(), // empty sessionMap
    );
    expect(spec.args).not.toContain('--resume');
  });

  it('no --resume when continue_from is undefined', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ continue_from: undefined }),
      makeTrack(),
      makeCtx(),
    );
    expect(spec.args).not.toContain('--resume');
  });
});

// ═══ ClaudeCodeDriver — cwd / --add-dir ═══

describe('ClaudeCodeDriver.buildCommand — cwd handling', () => {
  it('uses task.cwd as spawn cwd', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ cwd: '/tmp/test-workdir/sub' }),
      makeTrack(),
      makeCtx({ workDir: '/tmp/test-workdir' }),
    );
    expect(spec.cwd).toBe('/tmp/test-workdir/sub');
  });

  it('adds --add-dir when cwd is a subdirectory of workDir', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ cwd: '/tmp/test-workdir/sub' }),
      makeTrack(),
      makeCtx({ workDir: '/tmp/test-workdir' }),
    );
    expect(spec.args).toContain('--add-dir');
    expect(findArg(spec.args, '--add-dir')).toBe('/tmp/test-workdir');
  });

  it('no --add-dir when cwd equals workDir', async () => {
    const spec = await ClaudeCodeDriver.buildCommand(
      makeTask({ cwd: '/tmp/test-workdir' }),
      makeTrack(),
      makeCtx({ workDir: '/tmp/test-workdir' }),
    );
    expect(spec.args).not.toContain('--add-dir');
  });
});

// ═══ ClaudeCodeDriver.parseResult ═══

describe('ClaudeCodeDriver.parseResult', () => {
  it('extracts session_id from JSON stdout', () => {
    const meta = ClaudeCodeDriver.parseResult!(
      JSON.stringify({ session_id: 'sess-xyz', result: 'Hello' }),
      '',
    );
    expect(meta.sessionId).toBe('sess-xyz');
    expect(meta.normalizedOutput).toBe('Hello');
  });

  it('falls back to raw stdout when JSON is invalid', () => {
    const meta = ClaudeCodeDriver.parseResult!('plain text output', '');
    expect(meta.normalizedOutput).toBe('plain text output');
  });

  it('uses result > text > content fields in priority order', () => {
    const withResult = ClaudeCodeDriver.parseResult!(
      JSON.stringify({ result: 'R', text: 'T', content: 'C' }), '',
    );
    expect(withResult.normalizedOutput).toBe('R');

    const withText = ClaudeCodeDriver.parseResult!(
      JSON.stringify({ text: 'T', content: 'C' }), '',
    );
    expect(withText.normalizedOutput).toBe('T');

    const withContent = ClaudeCodeDriver.parseResult!(
      JSON.stringify({ content: 'C' }), '',
    );
    expect(withContent.normalizedOutput).toBe('C');
  });
});

// ═══ StaticContextMiddleware — prompt assembly ═══

const MW_TEST_DIR = resolve(process.cwd(), 'tests', 'workspaces', '_mw-test');

beforeAll(async () => {
  await mkdir(MW_TEST_DIR, { recursive: true });
  await Bun.write(resolve(MW_TEST_DIR, 'context.txt'), 'Reference content here');
});

afterAll(async () => {
  await rm(MW_TEST_DIR, { recursive: true, force: true });
});

function makeMwCtx(): MiddlewareContext {
  return {
    task: makeTask(),
    track: makeTrack(),
    outputMap: new Map(),
    workDir: MW_TEST_DIR,
  };
}

describe('StaticContextMiddleware.enhance — prompt assembly', () => {
  it('prepends file content with label in [Label]\\n...\\n\\n[Task]\\n... format', async () => {
    const result = await StaticContextMiddleware.enhance(
      'My prompt',
      { type: 'static_context', file: 'context.txt', label: 'My Label' },
      makeMwCtx(),
    );
    expect(result).toBe('[My Label]\nReference content here\n\n[Task]\nMy prompt');
  });

  it('uses filename as default label when label is omitted', async () => {
    const result = await StaticContextMiddleware.enhance(
      'Prompt',
      { type: 'static_context', file: 'context.txt' },
      makeMwCtx(),
    );
    expect(result).toStartWith('[Reference: context.txt]\n');
    expect(result).toEndWith('[Task]\nPrompt');
  });

  it('returns original prompt when file does not exist', async () => {
    const result = await StaticContextMiddleware.enhance(
      'Original prompt',
      { type: 'static_context', file: 'nonexistent.txt', label: 'X' },
      makeMwCtx(),
    );
    expect(result).toBe('Original prompt');
  });

  it('throws when file path is missing from config', async () => {
    expect(
      StaticContextMiddleware.enhance('p', { type: 'static_context' }, makeMwCtx()),
    ).rejects.toThrow('file');
  });
});
