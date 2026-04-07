import { describe, it, expect } from 'bun:test';
import { validateRaw } from '../../src/validate-raw';
import type { RawPipelineConfig } from '../../src/types';

function minimal(): RawPipelineConfig {
  return {
    name: 'test',
    tracks: [{
      id: 'main', name: 'Main',
      tasks: [{ id: 't1', command: 'echo ok' }],
    }],
  };
}

describe('validateRaw — valid config', () => {
  it('returns [] for minimal valid config', () => {
    expect(validateRaw(minimal())).toEqual([]);
  });

  it('returns [] for config with cross-track fully-qualified dep', () => {
    const config: RawPipelineConfig = {
      name: 'test',
      tracks: [
        { id: 'track_a', name: 'A', tasks: [{ id: 'task', command: 'echo' }] },
        { id: 'track_b', name: 'B', tasks: [{ id: 'dep', command: 'echo', depends_on: ['track_a.task'] }] },
      ],
    };
    expect(validateRaw(config)).toEqual([]);
  });

  it('returns [] for same-track bare ref', () => {
    const config: RawPipelineConfig = {
      name: 'test',
      tracks: [{
        id: 'main', name: 'Main',
        tasks: [
          { id: 'a', command: 'echo' },
          { id: 'b', command: 'echo', depends_on: ['a'] },
        ],
      }],
    };
    expect(validateRaw(config)).toEqual([]);
  });

  it('returns [] for valid continue_from', () => {
    const config: RawPipelineConfig = {
      name: 'test',
      tracks: [{
        id: 'main', name: 'Main',
        tasks: [
          { id: 'a', prompt: 'hello' },
          { id: 'b', prompt: 'world', continue_from: 'a' },
        ],
      }],
    };
    expect(validateRaw(config)).toEqual([]);
  });
});

describe('validateRaw — top-level errors', () => {
  it('reports missing name', () => {
    const errs = validateRaw({ ...minimal(), name: '' });
    expect(errs.some(e => e.path === 'name')).toBe(true);
  });

  it('reports whitespace-only name', () => {
    const errs = validateRaw({ ...minimal(), name: '   ' });
    expect(errs.some(e => e.path === 'name')).toBe(true);
  });

  it('reports empty tracks', () => {
    const errs = validateRaw({ name: 'test', tracks: [] });
    expect(errs.some(e => e.path === 'tracks')).toBe(true);
  });
});

describe('validateRaw — task errors', () => {
  it('reports task with no prompt or command', () => {
    const config: RawPipelineConfig = {
      name: 'test',
      tracks: [{ id: 'main', name: 'Main', tasks: [{ id: 't1' } as never] }],
    };
    const errs = validateRaw(config);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some(e => e.message.includes('prompt') || e.message.includes('command'))).toBe(true);
  });

  it('reports task with both prompt and command', () => {
    const config: RawPipelineConfig = {
      name: 'test',
      tracks: [{ id: 'main', name: 'Main', tasks: [{ id: 't1', prompt: 'p', command: 'c' }] }],
    };
    const errs = validateRaw(config);
    expect(errs.some(e => e.message.includes('both'))).toBe(true);
  });

  it('reports unresolved depends_on', () => {
    const config: RawPipelineConfig = {
      name: 'test',
      tracks: [{
        id: 'main', name: 'Main',
        tasks: [{ id: 't1', command: 'echo', depends_on: ['nonexistent'] }],
      }],
    };
    const errs = validateRaw(config);
    expect(errs.some(e => e.path.includes('depends_on'))).toBe(true);
  });

  it('reports unresolved continue_from', () => {
    const config: RawPipelineConfig = {
      name: 'test',
      tracks: [{
        id: 'main', name: 'Main',
        tasks: [{ id: 't1', prompt: 'hi', continue_from: 'ghost' }],
      }],
    };
    const errs = validateRaw(config);
    expect(errs.some(e => e.path.includes('continue_from'))).toBe(true);
  });

  it('reports ambiguous bare ref when dep is in a third track seeing two matches', () => {
    // 'dep' is in 'tc' which has no local 'shared', so bare 'shared' is ambiguous (ta + tb both have it)
    const config: RawPipelineConfig = {
      name: 'test',
      tracks: [
        { id: 'ta', name: 'A', tasks: [{ id: 'shared', command: 'echo' }] },
        { id: 'tb', name: 'B', tasks: [{ id: 'shared', command: 'echo' }] },
        { id: 'tc', name: 'C', tasks: [{ id: 'dep', command: 'echo', depends_on: ['shared'] }] },
      ],
    };
    const errs = validateRaw(config);
    expect(errs.some(e => e.message.includes('ambiguous'))).toBe(true);
  });
});

describe('validateRaw — cycle detection', () => {
  it('detects direct cycle A → B → A', () => {
    const config: RawPipelineConfig = {
      name: 'test',
      tracks: [{
        id: 'main', name: 'Main',
        tasks: [
          { id: 'a', command: 'echo', depends_on: ['b'] },
          { id: 'b', command: 'echo', depends_on: ['a'] },
        ],
      }],
    };
    const errs = validateRaw(config);
    expect(errs.some(e => e.message.includes('Circular'))).toBe(true);
  });

  it('detects self-loop A → A', () => {
    const config: RawPipelineConfig = {
      name: 'test',
      tracks: [{
        id: 'main', name: 'Main',
        tasks: [{ id: 'a', command: 'echo', depends_on: ['a'] }],
      }],
    };
    const errs = validateRaw(config);
    expect(errs.some(e => e.message.includes('Circular') || e.path.includes('depends_on'))).toBe(true);
  });

  it('detects three-node cycle A → B → C → A', () => {
    const config: RawPipelineConfig = {
      name: 'test',
      tracks: [{
        id: 'main', name: 'Main',
        tasks: [
          { id: 'a', command: 'echo', depends_on: ['c'] },
          { id: 'b', command: 'echo', depends_on: ['a'] },
          { id: 'c', command: 'echo', depends_on: ['b'] },
        ],
      }],
    };
    const errs = validateRaw(config);
    expect(errs.some(e => e.message.includes('Circular'))).toBe(true);
  });
});
