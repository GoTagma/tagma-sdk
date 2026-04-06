import type { TriggerPlugin, TriggerContext } from '../types';
import { parseDuration } from '../utils';

export const ManualTrigger: TriggerPlugin = {
  name: 'manual',

  async watch(config: Record<string, unknown>, ctx: TriggerContext): Promise<unknown> {
    const message =
      (config.message as string | undefined) ?? `Manual confirmation required for task "${ctx.taskId}"`;
    const timeoutMs = config.timeout ? parseDuration(config.timeout as string) : 0;
    const options = Array.isArray(config.options)
      ? (config.options as unknown[]).map(String)
      : undefined;
    const metadata =
      config.metadata && typeof config.metadata === 'object'
        ? (config.metadata as Record<string, unknown>)
        : undefined;

    const decisionPromise = ctx.approvalGateway.request({
      taskId: ctx.taskId,
      trackId: ctx.trackId,
      message,
      options,
      timeoutMs,
      metadata,
    });

    // Wire AbortSignal → try to resolve this specific request as aborted.
    // We can't directly cancel via the gateway (no id yet at .request() call site),
    // so instead we race against an abort promise and let engine status logic
    // fall back to pipelineAborted → skipped. abortAll() on gateway still runs
    // from engine shutdown path to clean up any truly-pending entries.
    const abortPromise = new Promise<never>((_, reject) => {
      if (ctx.signal.aborted) {
        reject(new Error('Pipeline aborted'));
        return;
      }
      ctx.signal.addEventListener(
        'abort',
        () => reject(new Error('Pipeline aborted')),
        { once: true },
      );
    });

    const decision = await Promise.race([decisionPromise, abortPromise]);

    switch (decision.outcome) {
      case 'approved':
        return { confirmed: true, approvalId: decision.approvalId, choice: decision.choice, actor: decision.actor };
      case 'rejected':
        throw new Error(
          `Manual trigger rejected by ${decision.actor ?? 'user'}` +
            (decision.reason ? `: ${decision.reason}` : ''),
        );
      case 'timeout':
        throw new Error(`Manual trigger timeout: ${decision.reason ?? 'no decision made'}`);
      case 'aborted':
        throw new Error(`Manual trigger aborted: ${decision.reason ?? 'pipeline aborted'}`);
    }
  },
};
