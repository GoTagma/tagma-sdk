import { describe, it, expect, mock } from 'bun:test';
import { expandTemplates } from '../../src/schema';
import type { RawTaskConfig } from '../../src/types';

// expandTemplates calls loadTemplate (dynamic import) for `use:` tasks.
// We mock the module resolution so no real packages are needed.

// The module path that loadTemplate will import() after stripping @v suffix.
// We need to mock at the import level. Since loadTemplate validates that refs
// start with @tagma/template-, we create a mock for that namespace.

const MOCK_TEMPLATE = {
  name: 'echo-test',
  params: {
    message: { type: 'string' as const, description: 'Message to echo' },
    output_dir: { type: 'path' as const, description: 'Output directory', default: '.out' },
    retries: { type: 'number' as const, min: 0, max: 10, default: 3 },
    level: { type: 'enum' as const, enum: ['info', 'warn', 'error'], default: 'info' },
  },
  tasks: [
    {
      id: 'step_a',
      name: 'Echo message',
      command: 'echo ${{ params.message }}',
      output: './tmp/${{ params.output_dir }}/result.txt',
    },
    {
      id: 'step_b',
      name: 'Verify',
      command: 'cat ${{ params.output_dir }}/result.txt',
      depends_on: ['step_a'],
    },
    {
      id: 'step_c',
      name: 'Continue step',
      prompt: 'Summarize at level ${{ params.level }}',
      continue_from: 'step_b',
      depends_on: ['step_b'],
    },
  ],
};

// Mock the dynamic import used by loadTemplate
mock.module('@tagma/template-echo', () => ({
  template: MOCK_TEMPLATE,
}));

describe('expandTemplates', () => {
  it('passes through non-template tasks unchanged', async () => {
    const tasks: RawTaskConfig[] = [
      { id: 'normal', command: 'echo hi' } as RawTaskConfig,
    ];
    const result = await expandTemplates(tasks, 'track1');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('normal');
    expect(result[0]!.command).toBe('echo hi');
  });

  it('expands template use: into prefixed tasks', async () => {
    const tasks: RawTaskConfig[] = [
      {
        id: 'my_echo',
        use: '@tagma/template-echo',
        with: { message: 'HELLO' },
      } as unknown as RawTaskConfig,
    ];
    const result = await expandTemplates(tasks, 'track1');

    // Template has 3 tasks → expanded with instance prefix
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe('my_echo.step_a');
    expect(result[1]!.id).toBe('my_echo.step_b');
    expect(result[2]!.id).toBe('my_echo.step_c');
  });

  it('substitutes ${{ params.xxx }} in command and prompt fields', async () => {
    const tasks: RawTaskConfig[] = [
      {
        id: 'my_echo',
        use: '@tagma/template-echo',
        with: { message: 'WORLD' },
      } as unknown as RawTaskConfig,
    ];
    const result = await expandTemplates(tasks, 'track1');

    expect(result[0]!.command).toBe('echo WORLD');
    expect(result[2]!.prompt).toBe('Summarize at level info'); // default param
  });

  it('namespaces depends_on to instance scope', async () => {
    const tasks: RawTaskConfig[] = [
      {
        id: 'inst',
        use: '@tagma/template-echo',
        with: { message: 'test' },
      } as unknown as RawTaskConfig,
    ];
    const result = await expandTemplates(tasks, 'track1');

    // step_b depends_on: [step_a] → inst.step_a
    expect(result[1]!.depends_on).toEqual(['inst.step_a']);
    // step_c depends_on: [step_b] → inst.step_b
    expect(result[2]!.depends_on).toEqual(['inst.step_b']);
  });

  it('namespaces continue_from to instance scope', async () => {
    const tasks: RawTaskConfig[] = [
      {
        id: 'inst',
        use: '@tagma/template-echo',
        with: { message: 'test' },
      } as unknown as RawTaskConfig,
    ];
    const result = await expandTemplates(tasks, 'track1');

    // step_c: continue_from: step_b → inst.step_b
    expect(result[2]!.continue_from).toBe('inst.step_b');
  });

  it('rewrites output path with instance namespace', async () => {
    const tasks: RawTaskConfig[] = [
      {
        id: 'inst',
        use: '@tagma/template-echo',
        with: { message: 'test', output_dir: 'my-dir' },
      } as unknown as RawTaskConfig,
    ];
    const result = await expandTemplates(tasks, 'track1');

    // output: ./tmp/${{ params.output_dir }}/result.txt → ./tmp/inst/my-dir/result.txt
    expect(result[0]!.output).toContain('inst');
  });

  it('uses default param values when not provided', async () => {
    const tasks: RawTaskConfig[] = [
      {
        id: 'inst',
        use: '@tagma/template-echo',
        with: { message: 'test' },
        // output_dir, retries, level not provided → use defaults
      } as unknown as RawTaskConfig,
    ];
    const result = await expandTemplates(tasks, 'track1');

    // level defaults to 'info'
    expect(result[2]!.prompt).toContain('info');
  });

  it('throws on missing required param', async () => {
    const tasks: RawTaskConfig[] = [
      {
        id: 'inst',
        use: '@tagma/template-echo',
        with: {}, // message is required, no default
      } as unknown as RawTaskConfig,
    ];
    await expect(expandTemplates(tasks, 'track1')).rejects.toThrow('missing required param "message"');
  });

  it('throws on wrong param type', async () => {
    const tasks: RawTaskConfig[] = [
      {
        id: 'inst',
        use: '@tagma/template-echo',
        with: { message: 123 }, // should be string
      } as unknown as RawTaskConfig,
    ];
    await expect(expandTemplates(tasks, 'track1')).rejects.toThrow('expected string');
  });

  it('throws on enum param with invalid value', async () => {
    const tasks: RawTaskConfig[] = [
      {
        id: 'inst',
        use: '@tagma/template-echo',
        with: { message: 'test', level: 'debug' }, // not in enum
      } as unknown as RawTaskConfig,
    ];
    await expect(expandTemplates(tasks, 'track1')).rejects.toThrow('not in allowed values');
  });

  it('throws on invalid template ref (path traversal)', async () => {
    const tasks: RawTaskConfig[] = [
      {
        id: 'inst',
        use: '../local-template',
        with: {},
      } as unknown as RawTaskConfig,
    ];
    await expect(expandTemplates(tasks, 'track1')).rejects.toThrow('path traversal');
  });

  it('throws on invalid template ref (not @tagma/template-*)', async () => {
    const tasks: RawTaskConfig[] = [
      {
        id: 'inst',
        use: '@other/some-template',
        with: {},
      } as unknown as RawTaskConfig,
    ];
    await expect(expandTemplates(tasks, 'track1')).rejects.toThrow('@tagma/template-');
  });

  it('mixes template and non-template tasks in order', async () => {
    const tasks: RawTaskConfig[] = [
      { id: 'before', command: 'echo before' } as RawTaskConfig,
      {
        id: 'tpl',
        use: '@tagma/template-echo',
        with: { message: 'MID' },
      } as unknown as RawTaskConfig,
      { id: 'after', command: 'echo after' } as RawTaskConfig,
    ];
    const result = await expandTemplates(tasks, 'track1');

    // before + 3 expanded + after = 5
    expect(result).toHaveLength(5);
    expect(result[0]!.id).toBe('before');
    expect(result[1]!.id).toBe('tpl.step_a');
    expect(result[2]!.id).toBe('tpl.step_b');
    expect(result[3]!.id).toBe('tpl.step_c');
    expect(result[4]!.id).toBe('after');
  });
});
