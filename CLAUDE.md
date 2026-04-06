# tagma-sdk

A local AI task orchestration SDK. Consumers (editor extensions, CLI tools, scripts) import and drive it programmatically.

## Packages

| Package | NPM | Role |
|---|---|---|
| `tagma-sdk` | `tagma-sdk` | Core engine |
| `@tagma/types` | `@tagma/types` | Shared type surface — no runtime code |
| `@tagma/driver-codex` | `@tagma/driver-codex` | Codex CLI driver plugin |
| `@tagma/driver-opencode` | `@tagma/driver-opencode` | OpenCode CLI driver plugin |

## Tech Stack

- Runtime: Bun >= 1.2, TypeScript 5.x
- Subprocess: `Bun.spawn()`, File I/O: `Bun.file()`, WebSocket: `Bun.serve()`
- YAML parsing: js-yaml, file watching: chokidar
- Tests: `bun test`

## Project Structure

```
src/
├── sdk.ts             # Public entry point — all exports live here
├── engine.ts          # Event-loop pipeline engine
├── pipeline-runner.ts # PipelineRunner class — multi-pipeline lifecycle management
├── config-ops.ts      # Immutable CRUD helpers for RawPipelineConfig (visual editor)
├── validate-raw.ts    # Raw config validation — structural + DAG, no runtime deps
├── dag.ts             # DAG construction & topological sort
├── runner.ts          # Task executor (Bun.spawn wrapper)
├── schema.ts          # YAML parsing, validation & template expansion
├── types.ts           # Re-exports @tagma/types + runtime constants
├── registry.ts        # Plugin registry
├── hooks.ts           # Hook lifecycle management
├── bootstrap.ts       # Built-in plugin pre-registration
├── approval.ts        # InMemoryApprovalGateway implementation
├── logger.ts          # Dual-channel logger
├── utils.ts           # Shared utilities
├── adapters/          # stdin and WebSocket approval adapters
├── drivers/           # Built-in driver: claude-code
├── triggers/          # Built-in triggers: file, manual
├── completions/       # Built-in completions: exit-code, file-exists, output-check
└── middlewares/       # Built-in middleware: static-context

plugins/
├── types/             # @tagma/types — type surface only
├── codex-driver/      # @tagma/driver-codex
└── opencode-driver/   # @tagma/driver-opencode
```

## Key Conventions

- All public exports live in `src/sdk.ts` — never import from internal modules directly
- All type definitions live in `plugins/types/src/index.ts`; `src/types.ts` is a re-export layer only
- External drivers live under `plugins/` and are not bundled into core
- All file path handling must use `validatePath` — no `..` traversal, no absolute paths
- `prompt` and `command` are mutually exclusive on a Task

## Publishing

```bash
bun run release          # interactive version bump (commit first)
bun run release:publish  # interactive version bump + publish
```

Publish order: `@tagma/types` → drivers → `tagma-sdk`. New plugins under `plugins/` are auto-scanned.
