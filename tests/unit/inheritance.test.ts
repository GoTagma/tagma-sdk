import { describe, it, expect } from 'bun:test';
import { parseYaml, resolveConfig } from '../../src/schema';
import { DEFAULT_PERMISSIONS } from '../../src/types';

// Tests that resolveConfig produces correctly inherited values
// across the pipeline → track → task hierarchy.

const FULL_YAML = `
pipeline:
  name: inheritance-test
  driver: claude-code
  timeout: 30s
  tracks:
    - id: track_a
      name: Track A
      model_tier: low
      permissions:
        read: true
        write: false
        execute: false
      agent_profile: "Track-level profile"
      middlewares:
        - type: static_context
          file: ctx.txt
          label: TrackCtx
      tasks:
        - id: inherits_all
          name: Inherits everything from track
          prompt: task1 prompt

        - id: overrides_all
          name: Overrides every inheritable field
          prompt: task2 prompt
          model_tier: high
          driver: codex
          permissions:
            read: true
            write: true
            execute: true
          agent_profile: "Task-level profile"
          middlewares: []

        - id: overrides_mw_only
          name: Overrides middlewares with different set
          prompt: task3 prompt
          middlewares:
            - type: static_context
              file: other.txt
              label: TaskCtx

    - id: track_b
      name: Track B — no overrides, inherits pipeline defaults
      tasks:
        - id: default_task
          name: Inherits pipeline-level defaults
          prompt: task4 prompt
`;

function resolved() {
  const raw = parseYaml(FULL_YAML);
  return resolveConfig(raw, '/tmp/test-workdir');
}

describe('resolveConfig — model_tier inheritance', () => {
  it('task inherits track model_tier when not set', () => {
    const config = resolved();
    const task = config.tracks[0]!.tasks[0]!; // inherits_all
    expect(task.model_tier).toBe('low');
  });

  it('task overrides track model_tier when set', () => {
    const config = resolved();
    const task = config.tracks[0]!.tasks[1]!; // overrides_all
    expect(task.model_tier).toBe('high');
  });

  it('task defaults to medium when neither track nor task sets model_tier', () => {
    const config = resolved();
    const task = config.tracks[1]!.tasks[0]!; // track_b.default_task
    expect(task.model_tier).toBe('medium');
  });
});

describe('resolveConfig — driver inheritance', () => {
  it('task inherits track driver, which inherits pipeline driver', () => {
    const config = resolved();
    const task = config.tracks[0]!.tasks[0]!; // inherits_all
    // track_a has no driver set → inherits pipeline's 'claude-code'
    expect(task.driver).toBe('claude-code');
  });

  it('task overrides driver', () => {
    const config = resolved();
    const task = config.tracks[0]!.tasks[1]!; // overrides_all
    expect(task.driver).toBe('codex');
  });

  it('defaults to claude-code when nothing is set', () => {
    const config = resolved();
    const task = config.tracks[1]!.tasks[0]!; // track_b.default_task
    expect(task.driver).toBe('claude-code');
  });
});

describe('resolveConfig — permissions inheritance', () => {
  it('task inherits track permissions', () => {
    const config = resolved();
    const task = config.tracks[0]!.tasks[0]!; // inherits_all
    expect(task.permissions).toEqual({ read: true, write: false, execute: false });
  });

  it('task overrides track permissions', () => {
    const config = resolved();
    const task = config.tracks[0]!.tasks[1]!; // overrides_all
    expect(task.permissions).toEqual({ read: true, write: true, execute: true });
  });

  it('defaults to DEFAULT_PERMISSIONS when nothing is set', () => {
    const config = resolved();
    const task = config.tracks[1]!.tasks[0]!; // track_b.default_task
    expect(task.permissions).toEqual(DEFAULT_PERMISSIONS);
  });
});

describe('resolveConfig — agent_profile inheritance', () => {
  it('task inherits track agent_profile', () => {
    const config = resolved();
    const task = config.tracks[0]!.tasks[0]!; // inherits_all
    expect(task.agent_profile).toBe('Track-level profile');
  });

  it('task overrides track agent_profile', () => {
    const config = resolved();
    const task = config.tracks[0]!.tasks[1]!; // overrides_all
    expect(task.agent_profile).toBe('Task-level profile');
  });

  it('is undefined when neither track nor task sets it', () => {
    const config = resolved();
    const task = config.tracks[1]!.tasks[0]!; // track_b.default_task
    expect(task.agent_profile).toBeUndefined();
  });
});

describe('resolveConfig — middlewares inheritance', () => {
  it('task inherits track middlewares when task.middlewares is undefined', () => {
    const config = resolved();
    const task = config.tracks[0]!.tasks[0]!; // inherits_all
    expect(task.middlewares).toHaveLength(1);
    expect(task.middlewares![0]!.type).toBe('static_context');
    expect((task.middlewares![0]! as Record<string, unknown>).label).toBe('TrackCtx');
  });

  it('task.middlewares: [] explicitly disables track middlewares', () => {
    const config = resolved();
    const task = config.tracks[0]!.tasks[1]!; // overrides_all
    expect(task.middlewares).toEqual([]);
  });

  it('task.middlewares replaces track middlewares entirely', () => {
    const config = resolved();
    const task = config.tracks[0]!.tasks[2]!; // overrides_mw_only
    expect(task.middlewares).toHaveLength(1);
    expect((task.middlewares![0]! as Record<string, unknown>).label).toBe('TaskCtx');
  });

  it('is undefined when neither track nor task sets middlewares', () => {
    const config = resolved();
    const task = config.tracks[1]!.tasks[0]!; // track_b.default_task
    expect(task.middlewares).toBeUndefined();
  });
});
