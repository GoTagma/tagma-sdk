// ═══ Raw Pipeline Config Validation ═══
//
// Validates a RawPipelineConfig without resolving inheritance or executing
// anything — intended for real-time feedback in a visual editor (e.g. drag
// to add a task, live error highlighting).
//
// Returns a flat list of ValidationError objects. An empty array means valid.

import type { RawPipelineConfig } from './types';

export interface ValidationError {
  /** JSONPath-style location, e.g. "tracks[0].tasks[1].prompt" */
  path: string;
  message: string;
}

/**
 * Validate a raw pipeline config.
 * Checks structure, required fields, prompt/command exclusivity,
 * depends_on reference integrity, and circular dependencies.
 *
 * Does NOT check plugin registration — plugins may not be loaded yet
 * when the frontend is editing a config offline.
 */
export function validateRaw(config: RawPipelineConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  // ── Top level ──
  if (!config.name?.trim()) {
    errors.push({ path: 'name', message: 'Pipeline name is required' });
  }

  if (!config.tracks || config.tracks.length === 0) {
    errors.push({ path: 'tracks', message: 'At least one track is required' });
    return errors; // No point going further without tracks
  }

  // ── Build qualified ID sets for cross-reference checks ──
  // Qualified ID format: "trackId.taskId" (mirrors the engine's convention)
  const allQualified = new Set<string>();
  // For bare depends_on references: bare taskId → first qualified ID found
  const bareToQualified = new Map<string, string>();

  for (const track of config.tracks) {
    if (!track.id) continue;
    for (const task of track.tasks ?? []) {
      if (!task.id) continue;
      const qid = `${track.id}.${task.id}`;
      allQualified.add(qid);
      if (!bareToQualified.has(task.id)) {
        bareToQualified.set(task.id, qid);
      }
    }
  }

  // ── Per-track validation ──
  for (let ti = 0; ti < config.tracks.length; ti++) {
    const track = config.tracks[ti];
    const trackPath = `tracks[${ti}]`;

    if (!track.id?.trim()) {
      errors.push({ path: `${trackPath}.id`, message: 'Track id is required' });
    }
    if (!track.name?.trim()) {
      errors.push({ path: `${trackPath}.name`, message: 'Track name is required' });
    }

    if (!track.tasks || track.tasks.length === 0) {
      errors.push({ path: `${trackPath}.tasks`, message: `Track "${track.id || ti}": must have at least one task` });
      continue;
    }

    // ── Per-task validation ──
    for (let ki = 0; ki < track.tasks.length; ki++) {
      const task = track.tasks[ki];
      const taskPath = `${trackPath}.tasks[${ki}]`;

      if (!task.id?.trim()) {
        errors.push({ path: `${taskPath}.id`, message: 'Task id is required' });
        continue; // Can't check further without an id
      }

      // Template-based tasks: skip prompt/command checks (params validated at runtime)
      if (task.use) continue;

      const hasPrompt = typeof task.prompt === 'string' && task.prompt.trim().length > 0;
      const hasCommand = typeof task.command === 'string' && task.command.trim().length > 0;

      if (!hasPrompt && !hasCommand) {
        errors.push({
          path: taskPath,
          message: `Task "${task.id}": must have "prompt" or "command"`,
        });
      }
      if (hasPrompt && hasCommand) {
        errors.push({
          path: taskPath,
          message: `Task "${task.id}": cannot have both "prompt" and "command"`,
        });
      }

      // ── depends_on reference checks ──
      if (task.depends_on && task.depends_on.length > 0) {
        for (const dep of task.depends_on) {
          const resolved = resolveDepRef(dep, track.id, allQualified, bareToQualified);
          if (!resolved) {
            errors.push({
              path: `${taskPath}.depends_on`,
              message: `Task "${task.id}": depends_on "${dep}" — no such task found`,
            });
          }
        }
      }

      // ── continue_from reference check ──
      if (task.continue_from) {
        const resolved = resolveDepRef(task.continue_from, track.id, allQualified, bareToQualified);
        if (!resolved) {
          errors.push({
            path: `${taskPath}.continue_from`,
            message: `Task "${task.id}": continue_from "${task.continue_from}" — no such task found`,
          });
        }
      }
    }
  }

  // ── Cycle detection ──
  errors.push(...detectCycles(config, allQualified, bareToQualified));

  return errors;
}

// ── Helpers ──

function resolveDepRef(
  ref: string,
  fromTrackId: string,
  allQualified: Set<string>,
  bareToQualified: Map<string, string>,
): string | null {
  // Fully qualified reference (trackId.taskId)
  if (allQualified.has(ref)) return ref;
  // Same-track shorthand (just taskId)
  const sameTrack = `${fromTrackId}.${ref}`;
  if (allQualified.has(sameTrack)) return sameTrack;
  // Global bare lookup (first match across all tracks)
  return bareToQualified.get(ref) ?? null;
}

function detectCycles(
  config: RawPipelineConfig,
  allQualified: Set<string>,
  bareToQualified: Map<string, string>,
): ValidationError[] {
  // Build adjacency: qualifiedId → [resolved dep qualifiedIds]
  const adj = new Map<string, string[]>();

  for (const track of config.tracks) {
    if (!track.id) continue;
    for (const task of track.tasks ?? []) {
      if (!task.id || task.use) continue;
      const qid = `${track.id}.${task.id}`;
      const deps: string[] = [];
      for (const dep of task.depends_on ?? []) {
        const resolved = resolveDepRef(dep, track.id, allQualified, bareToQualified);
        if (resolved) deps.push(resolved);
      }
      adj.set(qid, deps);
    }
  }

  const errors: ValidationError[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(id: string, path: string[]): void {
    if (inStack.has(id)) {
      // Trim path to just the cycle portion
      const cycleStart = path.indexOf(id);
      const cycle = [...path.slice(cycleStart), id].join(' → ');
      errors.push({ path: 'tracks', message: `Circular dependency detected: ${cycle}` });
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    inStack.add(id);
    for (const dep of adj.get(id) ?? []) {
      dfs(dep, [...path, id]);
    }
    inStack.delete(id);
  }

  for (const id of adj.keys()) {
    if (!visited.has(id)) dfs(id, []);
  }

  return errors;
}
