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

Executes the pipeline. Returns `{ success, summary, states }`.

Options:
- `approvalGateway` -- custom `ApprovalGateway` instance (defaults to `InMemoryApprovalGateway`)

### `loadPlugins(names: string[]): Promise<void>`

Dynamically loads and registers external plugin packages.

### `attachStdinApprovalAdapter(gateway): StdinApprovalAdapter`

Attaches an interactive stdin-based approval handler.

### `attachWebSocketApprovalAdapter(gateway, options?): WebSocketApprovalAdapter`

Starts a WebSocket server for remote approval decisions.

## Related Packages

| Package | Description |
|---|---|
| [@tagma/types](https://www.npmjs.com/package/@tagma/types) | Shared TypeScript types |
| [@tagma/driver-codex](https://www.npmjs.com/package/@tagma/driver-codex) | Codex CLI driver plugin |
| [@tagma/driver-opencode](https://www.npmjs.com/package/@tagma/driver-opencode) | OpenCode CLI driver plugin |
| [@tagma/cli](https://www.npmjs.com/package/@tagma/cli) | CLI runner |

## License

MIT
