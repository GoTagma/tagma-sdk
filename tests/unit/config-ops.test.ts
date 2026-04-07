import { describe, it, expect } from 'bun:test';
import {
  createEmptyPipeline, setPipelineField,
  upsertTrack, removeTrack, moveTrack, updateTrack,
  upsertTask, removeTask, moveTask, transferTask,
} from '../../src/config-ops';
import type { RawPipelineConfig, RawTrackConfig } from '../../src/types';

function makeTrack(id: string, taskDefs: Array<{ id: string; deps?: string[] }> = []): RawTrackConfig {
  return {
    id,
    name: id,
    tasks: taskDefs.map(t => ({
      id: t.id,
      command: 'echo ok',
      ...(t.deps ? { depends_on: t.deps } : {}),
    })),
  };
}

describe('createEmptyPipeline', () => {
  it('returns a pipeline with the given name and empty tracks', () => {
    const p = createEmptyPipeline('my-pipeline');
    expect(p.name).toBe('my-pipeline');
    expect(p.tracks).toEqual([]);
  });
});

describe('setPipelineField', () => {
  it('updates top-level fields immutably', () => {
    const orig = createEmptyPipeline('orig');
    const updated = setPipelineField(orig, { name: 'updated', timeout: '10s' });
    expect(updated.name).toBe('updated');
    expect(updated.timeout).toBe('10s');
    expect(orig.name).toBe('orig'); // original unchanged
  });

  it('preserves existing tracks when updating name', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1'));
    p = setPipelineField(p, { name: 'renamed' });
    expect(p.tracks).toHaveLength(1);
  });
});

describe('upsertTrack', () => {
  it('appends a new track', () => {
    const p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1'));
    expect(p.tracks).toHaveLength(1);
    expect(p.tracks[0]!.id).toBe('t1');
  });

  it('appends multiple tracks in order', () => {
    let p = createEmptyPipeline('test');
    p = upsertTrack(p, makeTrack('a'));
    p = upsertTrack(p, makeTrack('b'));
    expect(p.tracks.map(t => t.id)).toEqual(['a', 'b']);
  });

  it('replaces an existing track by id', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1'));
    const updated = { ...makeTrack('t1'), name: 'Updated Name' };
    p = upsertTrack(p, updated);
    expect(p.tracks).toHaveLength(1);
    expect(p.tracks[0]!.name).toBe('Updated Name');
  });

  it('does not mutate the original config', () => {
    const orig = createEmptyPipeline('test');
    upsertTrack(orig, makeTrack('t1'));
    expect(orig.tracks).toHaveLength(0);
  });
});

describe('removeTrack', () => {
  it('removes a track by id', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('a'));
    p = upsertTrack(p, makeTrack('b'));
    p = removeTrack(p, 'a');
    expect(p.tracks).toHaveLength(1);
    expect(p.tracks[0]!.id).toBe('b');
  });

  it('is a no-op for unknown id', () => {
    const p = upsertTrack(createEmptyPipeline('test'), makeTrack('a'));
    const p2 = removeTrack(p, 'nonexistent');
    expect(p2.tracks).toHaveLength(1);
  });
});

describe('moveTrack', () => {
  function threeTrackPipeline(): RawPipelineConfig {
    let p = createEmptyPipeline('test');
    p = upsertTrack(p, makeTrack('a'));
    p = upsertTrack(p, makeTrack('b'));
    p = upsertTrack(p, makeTrack('c'));
    return p;
  }

  it('moves track from index 0 to index 2', () => {
    const p = moveTrack(threeTrackPipeline(), 'a', 2);
    expect(p.tracks.map(t => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('moves track from index 2 to index 0', () => {
    const p = moveTrack(threeTrackPipeline(), 'c', 0);
    expect(p.tracks.map(t => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('clamps toIndex to upper bound', () => {
    const p = moveTrack(threeTrackPipeline(), 'a', 100);
    expect(p.tracks.map(t => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('clamps toIndex to lower bound (0)', () => {
    const p = moveTrack(threeTrackPipeline(), 'c', -5);
    expect(p.tracks.map(t => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op for unknown trackId', () => {
    const p = threeTrackPipeline();
    const p2 = moveTrack(p, 'ghost', 0);
    expect(p2.tracks.map(t => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('updateTrack', () => {
  it('updates track name and color without touching tasks', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1', [{ id: 'task1' }]));
    p = updateTrack(p, 't1', { name: 'Updated', color: '#ff0000' });
    expect(p.tracks[0]!.name).toBe('Updated');
    expect((p.tracks[0]! as Record<string, unknown>).color).toBe('#ff0000');
    expect(p.tracks[0]!.tasks).toHaveLength(1);
  });

  it('is a no-op for unknown trackId', () => {
    const p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1'));
    const p2 = updateTrack(p, 'ghost', { name: 'nope' });
    expect(p2.tracks[0]!.name).toBe('t1');
  });
});

describe('upsertTask', () => {
  it('appends a new task to the track', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1'));
    p = upsertTask(p, 't1', { id: 'task1', command: 'echo' });
    expect(p.tracks[0]!.tasks).toHaveLength(1);
    expect(p.tracks[0]!.tasks[0]!.id).toBe('task1');
  });

  it('replaces an existing task by id', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1', [{ id: 'task1' }]));
    p = upsertTask(p, 't1', { id: 'task1', command: 'replaced' });
    expect(p.tracks[0]!.tasks).toHaveLength(1);
    expect(p.tracks[0]!.tasks[0]!.command).toBe('replaced');
  });

  it('is a no-op for unknown trackId', () => {
    const p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1'));
    const p2 = upsertTask(p, 'ghost', { id: 'task1', command: 'echo' });
    expect(p2.tracks[0]!.tasks).toHaveLength(0);
  });
});

describe('removeTask', () => {
  it('removes a task by id', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1', [{ id: 'a' }, { id: 'b' }]));
    p = removeTask(p, 't1', 'a');
    expect(p.tracks[0]!.tasks).toHaveLength(1);
    expect(p.tracks[0]!.tasks[0]!.id).toBe('b');
  });

  it('is a no-op for unknown taskId', () => {
    const p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1', [{ id: 'a' }]));
    const p2 = removeTask(p, 't1', 'ghost');
    expect(p2.tracks[0]!.tasks).toHaveLength(1);
  });

  it('cleanRefs=true removes dangling depends_on', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1', [
      { id: 'a' },
      { id: 'b', deps: ['a'] },
    ]));
    p = removeTask(p, 't1', 'a', true);
    expect(p.tracks[0]!.tasks[0]!.depends_on).toBeUndefined();
  });

  it('cleanRefs=true keeps dep on surviving tasks', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1', [
      { id: 'a' }, { id: 'b' }, { id: 'c', deps: ['a', 'b'] },
    ]));
    p = removeTask(p, 't1', 'a', true);
    const c = p.tracks[0]!.tasks.find(t => t.id === 'c');
    expect(c?.depends_on).not.toContain('a');
    expect(c?.depends_on).toContain('b');
  });

  it('cleanRefs=false preserves dangling refs', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1', [
      { id: 'a' },
      { id: 'b', deps: ['a'] },
    ]));
    p = removeTask(p, 't1', 'a', false);
    const b = p.tracks[0]!.tasks.find(t => t.id === 'b');
    expect(b?.depends_on).toContain('a');
  });

  it('cleanRefs=true removes dangling continue_from', () => {
    let p = upsertTrack(createEmptyPipeline('test'), {
      id: 't1', name: 't1',
      tasks: [
        { id: 'a', prompt: 'hello' },
        { id: 'b', prompt: 'world', continue_from: 'a' },
      ],
    });
    p = removeTask(p, 't1', 'a', true);
    const b = p.tracks[0]!.tasks.find(t => t.id === 'b');
    expect(b?.continue_from).toBeUndefined();
  });

  it('cleanRefs=true keeps continue_from when target survives', () => {
    let p = upsertTrack(createEmptyPipeline('test'), {
      id: 't1', name: 't1',
      tasks: [
        { id: 'a', prompt: 'hello' },
        { id: 'b', prompt: 'world' },
        { id: 'c', prompt: 'test', continue_from: 'b', depends_on: ['a'] },
      ],
    });
    // Remove 'a', but 'c' continues from 'b' which survives
    p = removeTask(p, 't1', 'a', true);
    const c = p.tracks[0]!.tasks.find(t => t.id === 'c');
    expect(c?.continue_from).toBe('b');
    expect(c?.depends_on).toBeUndefined(); // 'a' dep was cleaned
  });
});

describe('moveTask', () => {
  it('reorders task to target index', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1', [
      { id: 'a' }, { id: 'b' }, { id: 'c' },
    ]));
    p = moveTask(p, 't1', 'a', 2);
    expect(p.tracks[0]!.tasks.map(t => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('clamps toIndex to upper bound', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1', [
      { id: 'a' }, { id: 'b' },
    ]));
    p = moveTask(p, 't1', 'a', 100);
    expect(p.tracks[0]!.tasks.map(t => t.id)).toEqual(['b', 'a']);
  });

  it('is a no-op for unknown taskId', () => {
    let p = upsertTrack(createEmptyPipeline('test'), makeTrack('t1', [{ id: 'a' }, { id: 'b' }]));
    p = moveTask(p, 't1', 'ghost', 0);
    expect(p.tracks[0]!.tasks.map(t => t.id)).toEqual(['a', 'b']);
  });
});

describe('transferTask', () => {
  it('moves a task from one track to another', () => {
    let p = createEmptyPipeline('test');
    p = upsertTrack(p, makeTrack('src', [{ id: 'task1' }, { id: 'task2' }]));
    p = upsertTrack(p, makeTrack('dst'));
    p = transferTask(p, 'src', 'task1', 'dst');
    expect(p.tracks.find(t => t.id === 'src')!.tasks).toHaveLength(1);
    expect(p.tracks.find(t => t.id === 'dst')!.tasks).toHaveLength(1);
    expect(p.tracks.find(t => t.id === 'dst')!.tasks[0]!.id).toBe('task1');
  });

  it('preserves task data during transfer', () => {
    let p = createEmptyPipeline('test');
    p = upsertTrack(p, makeTrack('src', [{ id: 'task1' }]));
    p = upsertTask(p, 'src', { id: 'task1', command: 'special-cmd' });
    p = upsertTrack(p, makeTrack('dst'));
    p = transferTask(p, 'src', 'task1', 'dst');
    expect(p.tracks.find(t => t.id === 'dst')!.tasks[0]!.command).toBe('special-cmd');
  });

  it('is a no-op when taskId is not found', () => {
    let p = createEmptyPipeline('test');
    p = upsertTrack(p, makeTrack('src', [{ id: 'a' }]));
    p = upsertTrack(p, makeTrack('dst'));
    const p2 = transferTask(p, 'src', 'ghost', 'dst');
    expect(p2).toBe(p); // referential equality — no new object
  });

  it('is a no-op when fromTrack is not found', () => {
    let p = createEmptyPipeline('test');
    p = upsertTrack(p, makeTrack('dst'));
    const p2 = transferTask(p, 'ghost', 'task1', 'dst');
    expect(p2).toBe(p);
  });
});
