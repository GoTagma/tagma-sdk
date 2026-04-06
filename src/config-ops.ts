// ═══ RawPipelineConfig CRUD Operations ═══
//
// Pure, immutable helper functions for building and editing pipeline configs
// in a visual editor. None of these functions have runtime dependencies —
// safe to import in any context (sidecar, renderer, tests).
//
// All operations return a new config object; inputs are never mutated.

import type { RawPipelineConfig, RawTrackConfig, RawTaskConfig } from './types';

// ── Pipeline ──

/**
 * Create a minimal empty pipeline config.
 */
export function createEmptyPipeline(name: string): RawPipelineConfig {
  return { name, tracks: [] };
}

/**
 * Update a top-level pipeline field (name, driver, timeout, etc.).
 */
export function setPipelineField(
  config: RawPipelineConfig,
  fields: Partial<Omit<RawPipelineConfig, 'tracks'>>,
): RawPipelineConfig {
  return { ...config, ...fields };
}

// ── Tracks ──

/**
 * Insert or replace a track by id. Appends if the id is new.
 */
export function upsertTrack(
  config: RawPipelineConfig,
  track: RawTrackConfig,
): RawPipelineConfig {
  const exists = config.tracks.some(t => t.id === track.id);
  return {
    ...config,
    tracks: exists
      ? config.tracks.map(t => (t.id === track.id ? track : t))
      : [...config.tracks, track],
  };
}

/**
 * Remove a track by id. No-op if the id is not found.
 */
export function removeTrack(
  config: RawPipelineConfig,
  trackId: string,
): RawPipelineConfig {
  return { ...config, tracks: config.tracks.filter(t => t.id !== trackId) };
}

/**
 * Move a track to a new index position (0-based).
 * Clamps toIndex to valid bounds.
 */
export function moveTrack(
  config: RawPipelineConfig,
  trackId: string,
  toIndex: number,
): RawPipelineConfig {
  const idx = config.tracks.findIndex(t => t.id === trackId);
  if (idx === -1) return config;
  const tracks = [...config.tracks];
  const [track] = tracks.splice(idx, 1);
  const clamped = Math.max(0, Math.min(toIndex, tracks.length));
  tracks.splice(clamped, 0, track);
  return { ...config, tracks };
}

/**
 * Update fields on a single track (excluding tasks list, use upsertTask / removeTask for that).
 */
export function updateTrack(
  config: RawPipelineConfig,
  trackId: string,
  fields: Partial<Omit<RawTrackConfig, 'id' | 'tasks'>>,
): RawPipelineConfig {
  return {
    ...config,
    tracks: config.tracks.map(t =>
      t.id === trackId ? { ...t, ...fields } : t,
    ),
  };
}

// ── Tasks ──

/**
 * Insert or replace a task within a track, matched by task.id. Appends if new.
 * No-op if the trackId is not found.
 */
export function upsertTask(
  config: RawPipelineConfig,
  trackId: string,
  task: RawTaskConfig,
): RawPipelineConfig {
  return {
    ...config,
    tracks: config.tracks.map(t => {
      if (t.id !== trackId) return t;
      const exists = t.tasks.some(tk => tk.id === task.id);
      return {
        ...t,
        tasks: exists
          ? t.tasks.map(tk => (tk.id === task.id ? task : tk))
          : [...t.tasks, task],
      };
    }),
  };
}

/**
 * Remove a task from a track. No-op if either id is not found.
 */
export function removeTask(
  config: RawPipelineConfig,
  trackId: string,
  taskId: string,
): RawPipelineConfig {
  return {
    ...config,
    tracks: config.tracks.map(t => {
      if (t.id !== trackId) return t;
      return { ...t, tasks: t.tasks.filter(tk => tk.id !== taskId) };
    }),
  };
}

/**
 * Reorder a task within its track.
 * Clamps toIndex to valid bounds.
 */
export function moveTask(
  config: RawPipelineConfig,
  trackId: string,
  taskId: string,
  toIndex: number,
): RawPipelineConfig {
  return {
    ...config,
    tracks: config.tracks.map(t => {
      if (t.id !== trackId) return t;
      const idx = t.tasks.findIndex(tk => tk.id === taskId);
      if (idx === -1) return t;
      const tasks = [...t.tasks];
      const [task] = tasks.splice(idx, 1);
      const clamped = Math.max(0, Math.min(toIndex, tasks.length));
      tasks.splice(clamped, 0, task);
      return { ...t, tasks };
    }),
  };
}

/**
 * Move a task from one track to another (appends to the target track).
 * No-op if either trackId or taskId is not found.
 */
export function transferTask(
  config: RawPipelineConfig,
  fromTrackId: string,
  taskId: string,
  toTrackId: string,
): RawPipelineConfig {
  let task: RawTaskConfig | undefined;
  const afterRemove = {
    ...config,
    tracks: config.tracks.map(t => {
      if (t.id !== fromTrackId) return t;
      const found = t.tasks.find(tk => tk.id === taskId);
      if (!found) return t;
      task = found;
      return { ...t, tasks: t.tasks.filter(tk => tk.id !== taskId) };
    }),
  };
  if (!task) return config;
  return upsertTask(afterRemove, toTrackId, task);
}
