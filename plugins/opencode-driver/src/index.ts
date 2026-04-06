import type {
  DriverPlugin, DriverCapabilities, DriverResultMeta,
  TaskConfig, TrackConfig, DriverContext, SpawnSpec, Permissions,
} from '@tagma-sdk/types';

const MODEL_MAP: Record<string, string> = {
  high: 'opencode/big-pickle', medium: 'opencode/big-pickle', low: 'opencode/big-pickle',
};

function resolveModel(tier: string): string {
  return MODEL_MAP[tier] ?? 'opencode/big-pickle';
}

const OpenCodeDriver: DriverPlugin = {
  name: 'opencode',

  capabilities: {
    sessionResume: true,      // supports --session
    systemPrompt: false,      // no --system-prompt flag; prepend to prompt instead
    outputFormat: true,       // supports --format json
  } satisfies DriverCapabilities,

  resolveModel,

  async buildCommand(
    task: TaskConfig, track: TrackConfig, ctx: DriverContext,
  ): Promise<SpawnSpec> {
    const model = resolveModel(task.model_tier ?? track.model_tier ?? 'medium');

    let prompt = task.prompt!;

    // agent_profile has no dedicated flag; prepend to prompt
    const profile = task.agent_profile ?? track.agent_profile;
    if (profile) {
      prompt = `[Role]\n${profile}\n\n[Task]\n${prompt}`;
    }

    // continue_from: prefer session resume, fall back to text injection
    let sessionId: string | null = null;
    if (task.continue_from) {
      sessionId = ctx.sessionMap.get(task.continue_from) ?? null;
      if (!sessionId) {
        // no session — degrade to text context passthrough
        let prev: string | null = null;
        if (ctx.normalizedMap.has(task.continue_from)) {
          prev = ctx.normalizedMap.get(task.continue_from)!;
        } else if (ctx.outputMap.has(task.continue_from)) {
          prev = await Bun.file(ctx.outputMap.get(task.continue_from)!).text();
        }
        if (prev !== null) {
          prompt = `[Previous Output]\n${prev}\n\n[Current Task]\n${prompt}`;
        }
      }
    }

    const args: string[] = [
      'opencode',
      'run',                    // subcommand
      prompt,                   // positional message
      '--model', model,
      '--format', 'json',       // JSON output for parseResult
    ];

    // session resume
    if (sessionId) {
      args.push('--session', sessionId);
    }

    return { args, cwd: task.cwd ?? ctx.workDir };
  },

  parseResult(stdout: string): DriverResultMeta {
    try {
      const json = JSON.parse(stdout);

      if (json.type === 'error') {
        return { normalizedOutput: undefined };
      }
      return {
        sessionId: json.session_id ?? json.sessionId ?? null,
        normalizedOutput: json.result ?? json.text ?? json.content ?? stdout,
      };
    } catch {
      return { normalizedOutput: stdout };
    }
  },
};

export const pluginCategory = 'drivers';
export const pluginType = 'opencode';
export default OpenCodeDriver;