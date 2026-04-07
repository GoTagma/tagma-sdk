import { describe, it, expect } from 'bun:test';
import {
  parseYaml, serializePipeline, deresolvePipeline,
  resolveConfig, validateConfig, loadPipeline,
} from '../../src/schema';

const SIMPLE_YAML = `
pipeline:
  name: test-pipeline
  tracks:
    - id: main
      name: Main
      tasks:
        - id: t1
          name: Task 1
          command: echo hello
`;

const MULTI_TRACK_YAML = `
pipeline:
  name: multi
  timeout: 30s
  tracks:
    - id: prep
      name: Prep
      tasks:
        - id: setup
          command: echo setup
    - id: work
      name: Work
      tasks:
        - id: run
          command: echo run
          depends_on: [prep.setup]
`;

describe('parseYaml', () => {
  it('parses minimal valid YAML', () => {
    const raw = parseYaml(SIMPLE_YAML);
    expect(raw.name).toBe('test-pipeline');
    expect(raw.tracks).toHaveLength(1);
    expect(raw.tracks[0]!.tasks[0]!.id).toBe('t1');
  });

  it('parses multi-track YAML with cross-track dep', () => {
    const raw = parseYaml(MULTI_TRACK_YAML);
    expect(raw.name).toBe('multi');
    expect(raw.timeout).toBe('30s');
    expect(raw.tracks).toHaveLength(2);
  });

  it('throws when top-level pipeline key is missing', () => {
    expect(() => parseYaml('tracks:\n  - id: x\n')).toThrow('pipeline');
  });

  it('throws when name is missing', () => {
    const yaml = `
pipeline:
  tracks:
    - id: main
      name: Main
      tasks:
        - id: t1
          command: echo
`;
    expect(() => parseYaml(yaml)).toThrow('name');
  });

  it('throws when tracks is empty', () => {
    expect(() => parseYaml('pipeline:\n  name: test\n  tracks: []\n')).toThrow('tracks');
  });

  it('throws when task has no prompt or command', () => {
    const yaml = `
pipeline:
  name: test
  tracks:
    - id: main
      name: Main
      tasks:
        - id: t1
          name: Task 1
`;
    expect(() => parseYaml(yaml)).toThrow();
  });

  it('throws when task has both prompt and command', () => {
    const yaml = `
pipeline:
  name: test
  tracks:
    - id: main
      name: Main
      tasks:
        - id: t1
          prompt: hello
          command: echo
`;
    expect(() => parseYaml(yaml)).toThrow('both');
  });
});

describe('serializePipeline', () => {
  it('produces YAML with top-level pipeline key', () => {
    const raw = parseYaml(SIMPLE_YAML);
    const yaml = serializePipeline(raw);
    expect(yaml).toContain('pipeline:');
    expect(yaml).toContain('test-pipeline');
  });

  it('round-trips: serialize then parse recovers the same config', () => {
    const raw = parseYaml(SIMPLE_YAML);
    const yaml = serializePipeline(raw);
    const re = parseYaml(yaml);
    expect(re.name).toBe(raw.name);
    expect(re.tracks[0]!.id).toBe(raw.tracks[0]!.id);
    expect(re.tracks[0]!.tasks[0]!.id).toBe(raw.tracks[0]!.tasks[0]!.id);
    expect(re.tracks[0]!.tasks[0]!.command).toBe(raw.tracks[0]!.tasks[0]!.command);
  });
});

describe('loadPipeline + resolveConfig', () => {
  it('resolves inheritance defaults', async () => {
    const config = await loadPipeline(SIMPLE_YAML, '/tmp/test-workdir');
    const task = config.tracks[0]!.tasks[0]!;
    expect(task.driver).toBe('claude-code');
    expect(task.model_tier).toBe('medium');
    expect(task.permissions).toBeDefined();
  });

  it('resolves cross-track depends_on', async () => {
    const config = await loadPipeline(MULTI_TRACK_YAML, '/tmp/test-workdir');
    const runTask = config.tracks[1]!.tasks[0]!;
    expect(runTask.depends_on).toContain('prep.setup');
  });
});

describe('validateConfig', () => {
  it('returns [] for valid config', async () => {
    const config = await loadPipeline(SIMPLE_YAML, '/tmp/test-workdir');
    expect(validateConfig(config)).toEqual([]);
  });
});

describe('deresolvePipeline', () => {
  it('round-trips deresolved config back through serialize + parse', async () => {
    const workDir = '/tmp/test-workdir';
    const config = await loadPipeline(SIMPLE_YAML, workDir);
    const raw = deresolvePipeline(config, workDir);
    expect(raw.name).toBe('test-pipeline');
    expect(raw.tracks[0]!.id).toBe('main');
    const yaml = serializePipeline(raw);
    const re = parseYaml(yaml);
    expect(re.name).toBe('test-pipeline');
    expect(re.tracks[0]!.tasks[0]!.command).toBe('echo hello');
  });

  it('omits default model_tier from deresolved output', async () => {
    const workDir = '/tmp/test-workdir';
    const config = await loadPipeline(SIMPLE_YAML, workDir);
    const raw = deresolvePipeline(config, workDir);
    // model_tier: medium is the default — should be stripped
    expect(raw.tracks[0]!.model_tier).toBeUndefined();
    expect(raw.tracks[0]!.tasks[0]!.model_tier).toBeUndefined();
  });
});
