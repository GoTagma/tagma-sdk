// ═══ @tagma/types ═══
//
// Shared type surface for the tagma-sdk engine and all plugins.
// This package contains ONLY types — no runtime code, no constants.
// Plugins depend on this so they stay decoupled from the engine's
// internal modules while remaining type-synchronized with it.

// ═══ Task Status ═══

export type TaskStatus =
  | 'idle'
  | 'waiting'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'skipped'
  | 'blocked';

export type OnFailure = 'ignore' | 'skip_downstream' | 'stop_all';

// ═══ Permissions ═══

export interface Permissions {
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
}

// ═══ Plugin Schema ═══
//
// Declarative metadata a plugin can expose so editors/UIs can render a typed
// form for its config instead of falling back to a raw key/value editor.
// Schema is purely descriptive — plugins still perform their own runtime
// validation. Declaring a field here is optional.

export type PluginParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'path'
  | 'duration'
  | 'number-or-list';

export interface PluginParamDef {
  readonly type: PluginParamType;
  readonly description?: string;
  readonly required?: boolean;
  readonly default?: unknown;
  readonly enum?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly placeholder?: string;
}

export interface PluginSchema {
  readonly description?: string;
  readonly fields: Readonly<Record<string, PluginParamDef>>;
}

// ═══ Trigger / Completion / Middleware Configs ═══

export interface TriggerConfig {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface CompletionConfig {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface MiddlewareConfig {
  readonly type: string;
  readonly [key: string]: unknown;
}

// ═══ Template Config ═══

export interface TemplateParamDef {
  readonly type?: 'string' | 'path' | 'enum' | 'number';
  readonly default?: unknown;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

export interface TemplateConfig {
  readonly name: string;
  readonly description?: string;
  readonly params?: Record<string, TemplateParamDef>;
  readonly tasks: readonly RawTaskConfig[];
}

// ═══ Task Config (after inheritance resolution) ═══

export interface TaskConfig {
  readonly id: string;
  readonly name: string;
  readonly prompt?: string;
  readonly command?: string;
  readonly depends_on?: readonly string[];
  readonly trigger?: TriggerConfig;
  readonly continue_from?: string;
  readonly output?: string;
  readonly model_tier?: string;
  readonly permissions?: Permissions;
  readonly driver?: string;
  readonly timeout?: string;
  readonly middlewares?: readonly MiddlewareConfig[];
  readonly completion?: CompletionConfig;
  readonly agent_profile?: string;
  readonly cwd?: string;
}

// ═══ Raw Task Config (from YAML, before inheritance) ═══

export interface RawTaskConfig {
  readonly id: string;
  readonly name?: string;
  readonly prompt?: string;
  readonly command?: string;
  readonly depends_on?: readonly string[];
  readonly trigger?: TriggerConfig;
  readonly continue_from?: string;
  readonly output?: string;
  readonly model_tier?: string;
  readonly permissions?: Permissions;
  readonly driver?: string;
  readonly timeout?: string;
  readonly middlewares?: readonly MiddlewareConfig[];
  readonly completion?: CompletionConfig;
  readonly agent_profile?: string;
  readonly cwd?: string;
  // Template usage
  readonly use?: string;
  readonly with?: Record<string, unknown>;
}

// ═══ Track Config ═══

export interface TrackConfig {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly agent_profile?: string;
  readonly model_tier?: string;
  readonly permissions?: Permissions;
  readonly driver?: string;
  readonly cwd?: string;
  readonly middlewares?: readonly MiddlewareConfig[];
  readonly on_failure?: OnFailure;
  readonly tasks: readonly TaskConfig[];
}

// ═══ Raw Track Config (from YAML) ═══

export interface RawTrackConfig {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly agent_profile?: string;
  readonly model_tier?: string;
  readonly permissions?: Permissions;
  readonly driver?: string;
  readonly cwd?: string;
  readonly middlewares?: readonly MiddlewareConfig[];
  readonly on_failure?: OnFailure;
  readonly tasks: readonly RawTaskConfig[];
}

// ═══ Hooks Config ═══

export type HookCommand = string | readonly string[];

export interface HooksConfig {
  readonly pipeline_start?: HookCommand;
  readonly task_start?: HookCommand;
  readonly task_success?: HookCommand;
  readonly task_failure?: HookCommand;
  readonly pipeline_complete?: HookCommand;
  readonly pipeline_error?: HookCommand;
}

// ═══ Pipeline Config ═══

export interface PipelineConfig {
  readonly name: string;
  readonly driver?: string;
  readonly timeout?: string;
  readonly plugins?: readonly string[];
  readonly hooks?: HooksConfig;
  readonly tracks: readonly TrackConfig[];
}

// ═══ Raw Pipeline Config (from YAML) ═══

export interface RawPipelineConfig {
  readonly name: string;
  readonly driver?: string;
  readonly timeout?: string;
  readonly plugins?: readonly string[];
  readonly hooks?: HooksConfig;
  readonly tracks: readonly RawTrackConfig[];
}

// ═══ SpawnSpec: Driver returns this to Engine ═══

export interface SpawnSpec {
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

// ═══ Driver Capabilities ═══

export interface DriverCapabilities {
  readonly sessionResume: boolean;
  readonly systemPrompt: boolean;
  readonly outputFormat: boolean;
}

// ═══ Driver Result Metadata ═══

export interface DriverResultMeta {
  readonly sessionId?: string;
  readonly normalizedOutput?: string;  // canonical text for continue_from handoff
}

// ═══ Driver Context ═══

export interface DriverContext {
  readonly sessionMap: Map<string, string>;
  readonly outputMap: Map<string, string>;
  // Canonical text for continue_from handoff (driver-normalized).
  // Falls back to output file content when a task doesn't provide a normalized form.
  readonly normalizedMap: Map<string, string>;
  readonly workDir: string;
}

// ═══ Driver Plugin ═══

export interface DriverPlugin {
  readonly name: string;
  readonly capabilities: DriverCapabilities;
  buildCommand(task: TaskConfig, track: TrackConfig, ctx: DriverContext): Promise<SpawnSpec>;
  parseResult?(stdout: string, stderr?: string): DriverResultMeta;
  resolveModel?(tier: string): string;
  resolveTools?(permissions: Permissions): string;
}

// ═══ Approval (used by Trigger plugins) ═══

export interface ApprovalRequest {
  readonly id: string;
  readonly taskId: string;
  readonly trackId?: string;
  readonly message: string;
  readonly createdAt: string;
  readonly timeoutMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ApprovalOutcome = 'approved' | 'rejected' | 'timeout' | 'aborted';

export interface ApprovalDecision {
  readonly approvalId: string;
  readonly outcome: ApprovalOutcome;
  readonly actor?: string;
  readonly reason?: string;
  readonly decidedAt: string;
}

export type ApprovalEvent =
  | { readonly type: 'requested'; readonly request: ApprovalRequest }
  | { readonly type: 'resolved'; readonly request: ApprovalRequest; readonly decision: ApprovalDecision }
  | { readonly type: 'expired'; readonly request: ApprovalRequest }
  | { readonly type: 'aborted'; readonly request: ApprovalRequest; readonly reason: string };

export type ApprovalListener = (event: ApprovalEvent) => void;

export interface ApprovalGateway {
  request(req: Omit<ApprovalRequest, 'id' | 'createdAt'>): Promise<ApprovalDecision>;
  resolve(
    approvalId: string,
    decision: Omit<ApprovalDecision, 'approvalId' | 'decidedAt'>,
  ): boolean;
  pending(): readonly ApprovalRequest[];
  subscribe(listener: ApprovalListener): () => void;
  abortAll(reason: string): void;
}

// ═══ Trigger Plugin ═══

export interface TriggerContext {
  readonly taskId: string;
  readonly trackId: string;
  readonly workDir: string;
  readonly signal: AbortSignal;
  readonly approvalGateway: ApprovalGateway;
}

export interface TriggerPlugin {
  readonly name: string;
  readonly schema?: PluginSchema;
  watch(config: Record<string, unknown>, ctx: TriggerContext): Promise<unknown>;
}

// ═══ Completion Plugin ═══

export interface CompletionContext {
  readonly workDir: string;
}

export interface CompletionPlugin {
  readonly name: string;
  readonly schema?: PluginSchema;
  check(config: Record<string, unknown>, result: TaskResult, ctx: CompletionContext): Promise<boolean>;
}

// ═══ Middleware Plugin ═══

export interface MiddlewareContext {
  readonly task: TaskConfig;
  readonly track: TrackConfig;
  readonly outputMap: Map<string, string>;
  readonly workDir: string;
}

export interface MiddlewarePlugin {
  readonly name: string;
  readonly schema?: PluginSchema;
  enhance(prompt: string, config: Record<string, unknown>, ctx: MiddlewareContext): Promise<string>;
}

// ═══ Task Result ═══

export interface TaskResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputPath: string | null;
  readonly stderrPath: string | null;
  readonly durationMs: number;
  readonly sessionId: string | null;
  readonly normalizedOutput: string | null;
}

// ═══ Runtime Task State (mutable engine state — exposed for hook context typing) ═══

export interface TaskState {
  readonly config: TaskConfig;
  readonly trackConfig: TrackConfig;
  status: TaskStatus;
  result: TaskResult | null;
  startedAt: string | null;
  finishedAt: string | null;
}

// ═══ Plugin Package Exports ═══

export type PluginCategory = 'drivers' | 'triggers' | 'completions' | 'middlewares';

export interface PluginModule {
  readonly pluginCategory: PluginCategory;
  readonly pluginType: string;
  readonly default: DriverPlugin | TriggerPlugin | CompletionPlugin | MiddlewarePlugin;
}
