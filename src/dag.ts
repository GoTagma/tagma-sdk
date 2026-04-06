import type { PipelineConfig, TaskConfig, TrackConfig } from './types';

export interface DagNode {
  readonly taskId: string;   // fully qualified: track_id.task_id or just task_id
  readonly task: TaskConfig;
  readonly track: TrackConfig;
  readonly dependsOn: readonly string[];
}

export interface Dag {
  readonly nodes: ReadonlyMap<string, DagNode>;
  readonly sorted: readonly string[];   // topological order
}

// Build a global task ID: for cross-track refs we use "track_id.task_id"
// Within a track, bare "task_id" is also valid
function qualifyId(trackId: string, taskId: string): string {
  return `${trackId}.${taskId}`;
}

export function buildDag(config: PipelineConfig): Dag {
  const nodes = new Map<string, DagNode>();
  // Map bare task IDs to qualified IDs (for resolving unqualified refs)
  const bareToQualified = new Map<string, string>();

  // 1. Register all nodes
  for (const track of config.tracks) {
    for (const task of track.tasks) {
      const qid = qualifyId(track.id, task.id);

      if (nodes.has(qid)) {
        throw new Error(`Duplicate task ID: "${qid}"`);
      }

      // Track bare ID → qualified. If same bare ID in multiple tracks, mark ambiguous
      if (bareToQualified.has(task.id)) {
        bareToQualified.set(task.id, '__ambiguous__');
      } else {
        bareToQualified.set(task.id, qid);
      }

      nodes.set(qid, {
        taskId: qid,
        task,
        track,
        dependsOn: [],  // filled below
      });
    }
  }

  // Helper to resolve a dependency ref to a qualified ID
  function resolveRef(ref: string, fromTrackId: string): string {
    // Already qualified (contains dot)
    if (ref.includes('.')) {
      if (!nodes.has(ref)) {
        throw new Error(`Task reference "${ref}" not found`);
      }
      return ref;
    }
    // Try within same track first
    const sameTrack = qualifyId(fromTrackId, ref);
    if (nodes.has(sameTrack)) return sameTrack;
    // Try global bare lookup
    const global = bareToQualified.get(ref);
    if (global && global !== '__ambiguous__') return global;
    if (global === '__ambiguous__') {
      throw new Error(
        `Ambiguous task reference "${ref}" exists in multiple tracks. ` +
        `Use "track_id.task_id" format.`
      );
    }
    throw new Error(`Task reference "${ref}" not found`);
  }

  // 2. Resolve depends_on and continue_from to qualified IDs
  for (const track of config.tracks) {
    for (const task of track.tasks) {
      const qid = qualifyId(track.id, task.id);
      const deps: string[] = [];

      if (task.depends_on) {
        for (const dep of task.depends_on) {
          deps.push(resolveRef(dep, track.id));
        }
      }
      if (task.continue_from) {
        const resolved = resolveRef(task.continue_from, track.id);
        if (!deps.includes(resolved)) {
          deps.push(resolved); // continue_from implies dependency
        }
      }

      // Replace node with resolved deps
      const node = nodes.get(qid)!;
      nodes.set(qid, { ...node, dependsOn: deps });
    }
  }

  // 3. Topological sort + cycle detection (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>(); // parent → children

  for (const [id] of nodes) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const [id, node] of nodes) {
    for (const dep of node.dependsOn) {
      adjacency.get(dep)!.push(id);
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const child of adjacency.get(current)!) {
      const newDegree = inDegree.get(child)! - 1;
      inDegree.set(child, newDegree);
      if (newDegree === 0) queue.push(child);
    }
  }

  if (sorted.length !== nodes.size) {
    const remaining = [...nodes.keys()].filter(id => !sorted.includes(id));
    throw new Error(`Circular dependency detected involving tasks: ${remaining.join(', ')}`);
  }

  return { nodes, sorted };
}
