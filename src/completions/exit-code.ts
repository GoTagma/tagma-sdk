import type { CompletionPlugin, CompletionContext, TaskResult } from '../types';

export const ExitCodeCompletion: CompletionPlugin = {
  name: 'exit_code',

  async check(config: Record<string, unknown>, result: TaskResult, _ctx: CompletionContext): Promise<boolean> {
    const expected = config.expect ?? 0;

    if (typeof expected === 'number') {
      return result.exitCode === expected;
    }
    if (Array.isArray(expected) && expected.every((v) => typeof v === 'number')) {
      return expected.includes(result.exitCode);
    }
    throw new Error(
      `exit_code completion: "expect" must be a number or number[], got ${typeof expected}`
    );
  },
};
