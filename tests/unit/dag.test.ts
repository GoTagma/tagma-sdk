import { describe, it, expect } from 'bun:test';
import { buildDag, buildRawDag } from '../../src/dag';
import type { PipelineConfig, RawPipelineConfig } from '../../src/types';

const PERMS = { read: true, write: true, execute: true };

function makeConfig(
  tracks: Array<{ id: string; tasks: Array<{ id: string; deps?: string[]; continueFrom?: string }> }>,
): PipelineConfig {
  return {
    name: 'test',
    tracks: tracks.map(t => ({
      id: t.id,
      name: t.id,
      model_tier: 'medium',
      permissions: PERMS,
      driver: 'claude-code',
      cwd: '/tmp',
      middlewares: [],
      on_failure: 'skip_downstream',
      tasks: t.tasks.map(tk => ({
        id: tk.id,
        name: tk.id,
        command: 'echo ok',
        model_tier: 'medium',
        permissions: PERMS,
        driver: 'claude-code',
        cwd: '/tmp',
        ...(tk.deps ? { depends_on: tk.deps } : {}),
        ...(tk.continueFrom ? { continue_from: tk.continueFrom } : {}),
      })),
    })),
  };
}

describe('buildDag — node registration', () => {
  it('creates fully-qualified node IDs', () => {
    const dag = buildDag(makeConfig([{ id: 'tr', tasks: [{ id: 'tk' }] }]));
    expect(dag.nodes.has('tr.tk')).toBe(true);
  });

  it('throws on duplicate qualified task id', () => {
    expect(() =>
      buildDag(makeConfig([{ id: 'main', tasks: [{ id: 'dup' }, { id: 'dup' }] }]))
    ).toThrow('Duplicate');
  });
});

describe('buildDag — dependency resolution', () => {
  it('resolves same-track bare ref', () => {
    const dag = buildDag(makeConfig([{
      id: 'main',
      tasks: [{ id: 'a' }, { id: 'b', deps: ['a'] }],
    }]));
    expect(dag.nodes.get('main.b')!.dependsOn).toEqual(['main.a']);
  });

  it('resolves cross-track fully-qualified ref', () => {
    const dag = buildDag(makeConfig([
      { id: 'ta', tasks: [{ id: 'x' }] },
      { id: 'tb', tasks: [{ id: 'y', deps: ['ta.x'] }] },
    ]));
    expect(dag.nodes.get('tb.y')!.dependsOn).toEqual(['ta.x']);
  });

  it('resolves unambiguous global bare ref', () => {
    const dag = buildDag(makeConfig([
      { id: 'ta', tasks: [{ id: 'only_one' }] },
      { id: 'tb', tasks: [{ id: 'dep', deps: ['only_one'] }] },
    ]));
    expect(dag.nodes.get('tb.dep')!.dependsOn).toEqual(['ta.only_one']);
  });

  it('throws on unknown ref', () => {
    expect(() =>
      buildDag(makeConfig([{ id: 'main', tasks: [{ id: 'a', deps: ['ghost'] }] }]))
    ).toThrow();
  });

  it('throws on ambiguous bare ref (dep in a third track, ref matches two others)', () => {
    // 'dep' lives in 'tc' — no local 'shared' in tc, so bare 'shared' is globally ambiguous
    expect(() =>
      buildDag(makeConfig([
        { id: 'ta', tasks: [{ id: 'shared' }] },
        { id: 'tb', tasks: [{ id: 'shared' }] },
        { id: 'tc', tasks: [{ id: 'dep', deps: ['shared'] }] },
      ]))
    ).toThrow('Ambiguous');
  });

  it('continue_from implies dependency', () => {
    const dag = buildDag(makeConfig([{
      id: 'main',
      tasks: [
        { id: 'a', },
        { id: 'b', continueFrom: 'a' },
      ],
    }]));
    expect(dag.nodes.get('main.b')!.dependsOn).toContain('main.a');
  });

  it('continue_from is deduplicated with explicit depends_on', () => {
    const dag = buildDag(makeConfig([{
      id: 'main',
      tasks: [
        { id: 'a' },
        { id: 'b', deps: ['a'], continueFrom: 'a' },
      ],
    }]));
    // Only one entry for main.a, not two
    expect(dag.nodes.get('main.b')!.dependsOn).toHaveLength(1);
    expect(dag.nodes.get('main.b')!.dependsOn[0]).toBe('main.a');
  });
});

describe('buildDag — topological sort', () => {
  it('root task comes before dependent', () => {
    const dag = buildDag(makeConfig([{
      id: 'main',
      tasks: [{ id: 'a' }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['b'] }],
    }]));
    const idx = (id: string) => dag.sorted.indexOf(id);
    expect(idx('main.a')).toBeLessThan(idx('main.b'));
    expect(idx('main.b')).toBeLessThan(idx('main.c'));
  });

  it('parallel tasks can be in any order relative to each other', () => {
    const dag = buildDag(makeConfig([{
      id: 'main',
      tasks: [{ id: 'x' }, { id: 'y' }],
    }]));
    expect(dag.sorted).toHaveLength(2);
    expect(dag.sorted).toContain('main.x');
    expect(dag.sorted).toContain('main.y');
  });

  it('throws on circular dependency', () => {
    expect(() =>
      buildDag(makeConfig([{
        id: 'main',
        tasks: [{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }],
      }]))
    ).toThrow('Circular');
  });
});

describe('buildRawDag', () => {
  it('builds raw dag with edges', () => {
    const raw: RawPipelineConfig = {
      name: 'test',
      tracks: [{
        id: 'main', name: 'Main',
        tasks: [
          { id: 'a', command: 'echo' },
          { id: 'b', command: 'echo', depends_on: ['a'] },
        ],
      }],
    };
    const dag = buildRawDag(raw);
    expect(dag.nodes.size).toBe(2);
    expect(dag.edges).toHaveLength(1);
    expect(dag.edges[0]).toEqual({ from: 'main.a', to: 'main.b' });
  });

  it('silently skips missing refs (lenient mode)', () => {
    const raw: RawPipelineConfig = {
      name: 'test',
      tracks: [{
        id: 'main', name: 'Main',
        tasks: [{ id: 'a', command: 'echo', depends_on: ['nonexistent'] }],
      }],
    };
    expect(() => buildRawDag(raw)).not.toThrow();
    expect(buildRawDag(raw).edges).toHaveLength(0);
  });

  it('skips template tasks (use field)', () => {
    const raw: RawPipelineConfig = {
      name: 'test',
      tracks: [{
        id: 'main', name: 'Main',
        tasks: [
          { id: 'a', command: 'echo' },
          { id: 'b', use: '@tagma/template-review' } as never,
        ],
      }],
    };
    const dag = buildRawDag(raw);
    expect(dag.nodes.size).toBe(1);
    expect(dag.nodes.has('main.a')).toBe(true);
  });

  it('includes continue_from as an edge', () => {
    const raw: RawPipelineConfig = {
      name: 'test',
      tracks: [{
        id: 'main', name: 'Main',
        tasks: [
          { id: 'a', prompt: 'hello' },
          { id: 'b', prompt: 'world', continue_from: 'a' },
        ],
      }],
    };
    const dag = buildRawDag(raw);
    expect(dag.edges.some(e => e.from === 'main.a' && e.to === 'main.b')).toBe(true);
  });
});
