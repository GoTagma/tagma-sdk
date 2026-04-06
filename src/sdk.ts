// ═══ tagma-sdk public API ═══
//
// This is the SDK entry point. Import from here, not from internal modules.
// The CLI (src/index.ts in the CLI project) also imports from here.

// ── Core engine ──
export { runPipeline } from './engine';
export type { EngineResult, RunPipelineOptions } from './engine';

// ── Schema: parse / resolve / load ──
export { parseYaml, resolveConfig, expandTemplates, loadPipeline } from './schema';

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

// ── Utils (public subset) ──
export { parseDuration, validatePath, generateRunId, nowISO } from './utils';

// ── All types from @tagma-sdk/types + runtime constants ──
export * from './types';
