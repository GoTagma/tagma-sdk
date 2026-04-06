# @tagma/sdk

A local AI task orchestration SDK for [Bun](https://bun.sh). Define multi-track pipelines in YAML, run AI coding agents (Claude Code, Codex, OpenCode) and shell commands in parallel with dependency resolution, approval gates, and lifecycle hooks.

## Install

```bash
bun add @tagma/sdk
```

## Quick Start

**1. Define a pipeline** (`pipeline.yaml`)

```yaml
pipeline:
  name: build-and-test
  tracks:
    - id: backend
      name: Backend
      driver: claude-code
      permissions: { read: true, write: true, execute: false }
      tasks:
        - id: implement
          name: Implement feature
          prompt: "Add a /health endpoint to src/server.ts"
          output: ./output/implement.txt
        - id: test
          name: Run tests
          command: "bun test"
          depends_on: [implement]
```

**2. Run it programmatically**

```ts
import {
  bootstrapBuiltins,
  loadPipeline,
  runPipeline,
  InMemoryApprovalGateway,
} from '@tagma/sdk';

// Register built-in drivers, triggers, completions
bootstrapBuiltins();

const yaml = await Bun.file('pipeline.yaml').text();
const config = await loadPipeline(yaml, process.cwd());

const result = await runPipeline(config, process.cwd());
console.log(result.success ? 'Done' : 'Failed');
```

## Features

- **Multi-track DAG execution** -- tasks run in parallel across tracks, respecting `depends_on` ordering
- **Driver plugins** -- built-in `claude-code` driver; install `@tagma/driver-codex` or `@tagma/driver-opencode` for other agents
- **Session handoff** -- `continue_from` passes context between tasks (session resume or text injection)
- **Approval gates** -- trigger-based approval with stdin and WebSocket adapters
- **Lifecycle hooks** -- `pipeline_start`, `task_start`, `task_success`, `task_failure`, `pipeline_complete`, `pipeline_error`
- **Middleware** -- enrich prompts before execution (e.g. inject static context)
- **Completion checks** -- validate task output with `exit_code`, `file_exists`, or `output_check` plugins
- **Template expansion** -- reusable task templates with parameterized `use` / `with`

## Pipeline YAML Reference

```yaml
pipeline:
  name: my-pipeline
  driver: claude-code          # default driver for all tasks
  timeout: 30m                 # pipeline-level timeout
  plugins:                     # load external driver plugins
    - "@tagma/driver-codex"
  hooks:
    pipeline_start: "echo starting"
    task_failure: "notify-slack.sh"
  tracks:
    - id: track-1
      name: Track One
      model_tier: high          # high | medium | low
      permissions:
        read: true
        write: true
        execute: false
      on_failure: skip_downstream  # skip_downstream | stop_all | ignore
      tasks:
        - id: task-a
          name: Do something
          prompt: "Your prompt here"
          output: ./output/task-a.txt
          timeout: 10m
        - id: task-b
          name: Follow up
          prompt: "Continue the work"
          continue_from: task-a
          depends_on: [task-a]
```

## API

### `bootstrapBuiltins()`

Registers all built-in plugins (claude-code driver, file/manual triggers, completion checks, static-context middleware).

### `loadPipeline(yaml: string, workDir: string): Promise<PipelineConfig>`

Parses YAML, resolves inheritance, expands templates, and validates the configuration.

### `runPipeline(config, workDir, options?): Promise<EngineResult>`

Executes the pipeline. Returns `{ success, runId, logPath, summary, states }`.

Options:
- `approvalGateway` -- custom `ApprovalGateway` instance (defaults to `InMemoryApprovalGateway`)
- `signal` -- `AbortSignal` to cancel the run externally
- `onEvent` -- callback for real-time `PipelineEvent` updates:
  - `pipeline_start` — pipeline began; includes `states: ReadonlyMap<taskId, TaskState>` (initial snapshot of all tasks at `waiting`)
  - `task_status_change` — a task changed status; includes `state: TaskState` (complete snapshot at the time of change, with `result` and `finishedAt` already populated for terminal statuses)
  - `pipeline_end` — pipeline finished; includes `success: boolean`
- `maxLogRuns` -- number of per-run log directories to keep under `<workDir>/logs/` (default: 20)

### `PipelineRunner`

Higher-level wrapper for managing multiple concurrent pipeline runs — designed for sidecar / Tauri IPC scenarios where the frontend controls pipeline lifecycle by ID.

```ts
const runner = new PipelineRunner(config, workDir);

// Subscribe before start — handler is called for every PipelineEvent
const unsubscribe = runner.subscribe(event => {
  tauriEmit('pipeline_event', { id: runner.instanceId, event });
});

runner.start(); // returns Promise<EngineResult>, idempotent

// Cancel from IPC
runner.abort();

// Available from the first pipeline_start event onward (not just after completion)
// Returns null only if the pipeline has never started
const states = runner.getStates(); // ReadonlyMap<taskId, TaskState> | null
```

Properties:
- `instanceId` — stable ID assigned at construction, safe to use as a Map key before `start()`
- `runId` — engine-assigned run ID, available after the first `pipeline_start` event (`null` until then)
- `status` — `'idle' | 'running' | 'done' | 'aborted'`

### `loadPlugins(names: string[]): Promise<void>`

Dynamically loads and registers external plugin packages.

### `attachStdinApprovalAdapter(gateway): StdinApprovalAdapter`

Attaches an interactive stdin-based approval handler.

### `attachWebSocketApprovalAdapter(gateway, options?): WebSocketApprovalAdapter`

Starts a WebSocket server for remote approval decisions.

### Config CRUD (`config-ops`)

Pure, immutable helper functions for building and editing `RawPipelineConfig` in a visual editor. No runtime dependencies — safe to use in renderer processes.

```ts
import {
  createEmptyPipeline, setPipelineField,
  upsertTrack, removeTrack, moveTrack, updateTrack,
  upsertTask, removeTask, moveTask, transferTask,
  serializePipeline,
} from '@tagma/sdk';

// Build a config programmatically
let config = createEmptyPipeline('my-pipeline');
config = upsertTrack(config, { id: 'backend', name: 'Backend', tasks: [] });
config = upsertTask(config, 'backend', { id: 'implement', prompt: 'Add /health endpoint' });

// Sync back to YAML
const yaml = serializePipeline(config);
```

| Function | Description |
|---|---|
| `createEmptyPipeline(name)` | Create a minimal pipeline config |
| `setPipelineField(config, fields)` | Update top-level pipeline fields |
| `upsertTrack(config, track)` | Insert or replace a track by id |
| `removeTrack(config, trackId)` | Remove a track |
| `moveTrack(config, trackId, toIndex)` | Reorder a track |
| `updateTrack(config, trackId, fields)` | Patch track fields (not tasks) |
| `upsertTask(config, trackId, task)` | Insert or replace a task |
| `removeTask(config, trackId, taskId, cleanRefs?)` | Remove a task; pass `cleanRefs: true` to also strip dangling `depends_on` / `continue_from` references from other tasks |
| `moveTask(config, trackId, taskId, toIndex)` | Reorder a task within its track |
| `transferTask(config, fromTrackId, taskId, toTrackId)` | Move a task across tracks |

### `parseYaml(content: string): RawPipelineConfig`

Parses a YAML string and returns the raw (unresolved) pipeline config. Use this when you need to edit and re-save YAML without losing relative paths or user-authored formatting — pass the result to `serializePipeline()` rather than going through `loadPipeline()`.

### `deresolvePipeline(config: PipelineConfig, workDir: string): RawPipelineConfig`

Converts a resolved `PipelineConfig` back to a `RawPipelineConfig` suitable for serialization. Strips injected defaults and converts absolute `cwd` paths back to relative so the output YAML is portable across machines.

Use this when you have a programmatically modified resolved config and need to save it back to YAML:

```ts
// Correct: load → modify resolved config → deresolve → save
const config = await loadPipeline(yaml, workDir);
const modified = { ...config, name: 'renamed' };
const savedYaml = serializePipeline(deresolvePipeline(modified, workDir));

// Also correct: work entirely in raw space (preferred for visual editors)
const raw = parseYaml(yaml);
const updatedRaw = setPipelineField(raw, { name: 'renamed' });
const savedYaml = serializePipeline(updatedRaw);
```

### `validateConfig(config: PipelineConfig): string[]`

Validates a resolved pipeline config without executing it. Checks DAG structure (cycles, missing dependencies). Returns an array of error message strings — empty means valid.

Use `validateRaw` for editing raw configs in a UI; use `validateConfig` after `resolveConfig` for a final pre-run check.

### `validateRaw(config: RawPipelineConfig): ValidationError[]`

Validates a raw pipeline config without resolving inheritance or executing anything. Returns a flat list of `{ path, message }` objects — empty array means valid.

Checks: required fields, `prompt`/`command` exclusivity, `depends_on`/`continue_from` reference integrity, circular dependency detection.

Does **not** check plugin registration (plugins may not be loaded at edit time).

```ts
const errors = validateRaw(draftConfig);
if (errors.length > 0) {
  errors.forEach(e => highlightNode(e.path, e.message));
}
```

### `buildRawDag(config: RawPipelineConfig): RawDag`

Extracts the topology of a raw (unresolved) pipeline config as a graph — no `workDir` or plugin registration required. Intended for the visual editor to render the flow graph during editing.

Returns `{ nodes: ReadonlyMap<taskId, RawDagNode>, edges: { from, to }[] }` where each edge represents a dependency (from must complete before to). Template-expansion tasks (`use:` field) and unresolvable refs are silently skipped.

```ts
const { nodes, edges } = buildRawDag(draftConfig);
// nodes — keyed by "trackId.taskId"
// edges — [{ from: "track.taskA", to: "track.taskB" }, ...]
```

Use `buildDag` instead when you have a fully resolved `PipelineConfig` and need topological sort order.

## Related Packages

| Package | Description |
|---|---|
| [@tagma/types](https://www.npmjs.com/package/@tagma/types) | Shared TypeScript types |
| [@tagma/driver-codex](https://www.npmjs.com/package/@tagma/driver-codex) | Codex CLI driver plugin |
| [@tagma/driver-opencode](https://www.npmjs.com/package/@tagma/driver-opencode) | OpenCode CLI driver plugin |
| [@tagma/cli](https://www.npmjs.com/package/@tagma/cli) | CLI runner |

## License

MIT
