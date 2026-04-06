// ═══ tagma-sdk public API ═══
//
// This is the SDK entry point. Import from here, not from internal modules.
// The CLI (src/index.ts in the CLI project) also imports from here.

// ── Core engine ──
export { runPipeline } from './engine';
export type { EngineResult, RunPipelineOptions, PipelineEvent } from './engine';

// ── Schema: parse / resolve / load / serialize / validate ──
export { parseYaml, resolveConfig, expandTemplates, loadPipeline, serializePipeline, validateConfig } from './schema';

// ── DAG ──
export { buildDag } from './dag';
export type { DagNode, Dag } from './dag';

// ── Plugin registry ──
export { bootstrapBuiltins } from './bootstrap';
export { loadPlugins, registerPlugin, getHandler, hasHandler, listRegistered } from './registry';

// ── Approval gateway ──
export { InMemoryApprovalGateway } from './approval';
export type {
  ApprovalGateway,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalEvent,
  ApprovalListener,
} from './approval';

// ── Approval adapters ──
export { attachStdinApprovalAdapter } from './adapters/stdin-approval';
export type { StdinApprovalAdapter } from './adapters/stdin-approval';
export { attachWebSocketApprovalAdapter } from './adapters/websocket-approval';
export type { WebSocketApprovalAdapter, WebSocketApprovalAdapterOptions } from './adapters/websocket-approval';

// ── Logger ──
export { Logger, tailLines, clip } from './logger';

// ── Hook context types (useful for frontend display) ──
export type { HookResult, PipelineInfo, TrackInfo, TaskInfo } from './hooks';

// ── Utils (public subset) ──
export { parseDuration, validatePath, generateRunId, nowISO, truncateForName } from './utils';

// ── All types from @tagma/types + runtime constants ──
export * from './types';
