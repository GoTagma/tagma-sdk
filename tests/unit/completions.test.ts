import { describe, it, expect } from 'bun:test';
import { FileExistsCompletion } from '../../src/completions/file-exists';
import { OutputCheckCompletion } from '../../src/completions/output-check';
import type { TaskResult, CompletionContext } from '../../src/types';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ── Shared test fixtures ──

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    outputPath: null,
    stderrPath: null,
    durationMs: 100,
    sessionId: null,
    normalizedOutput: null,
    ...overrides,
  };
}

function makeCtx(workDir: string): CompletionContext {
  return { workDir };
}

let tempDir: string;

function setupTempDir(): string {
  tempDir = mkdtempSync(resolve(tmpdir(), 'tagma-completion-test-'));
  return tempDir;
}

function cleanupTempDir(): void {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ═══ FileExistsCompletion ═══

describe('FileExistsCompletion', () => {
  it('throws when path is missing', async () => {
    const workDir = setupTempDir();
    try {
      await FileExistsCompletion.check({}, makeResult(), makeCtx(workDir));
      expect(true).toBe(false); // should not reach
    } catch (err: unknown) {
      expect((err as Error).message).toContain('"path" is required');
    } finally {
      cleanupTempDir();
    }
  });

  it('throws when kind is invalid', async () => {
    const workDir = setupTempDir();
    try {
      await FileExistsCompletion.check(
        { path: 'test.txt', kind: 'symlink' },
        makeResult(),
        makeCtx(workDir),
      );
      expect(true).toBe(false);
    } catch (err: unknown) {
      expect((err as Error).message).toContain('"kind" must be');
      expect((err as Error).message).toContain('symlink');
    } finally {
      cleanupTempDir();
    }
  });

  it('throws when min_size is negative', async () => {
    const workDir = setupTempDir();
    try {
      await FileExistsCompletion.check(
        { path: 'test.txt', min_size: -1 },
        makeResult(),
        makeCtx(workDir),
      );
      expect(true).toBe(false);
    } catch (err: unknown) {
      expect((err as Error).message).toContain('min_size');
    } finally {
      cleanupTempDir();
    }
  });

  it('throws when min_size is not a number', async () => {
    const workDir = setupTempDir();
    try {
      await FileExistsCompletion.check(
        { path: 'test.txt', min_size: 'big' },
        makeResult(),
        makeCtx(workDir),
      );
      expect(true).toBe(false);
    } catch (err: unknown) {
      expect((err as Error).message).toContain('min_size');
    } finally {
      cleanupTempDir();
    }
  });

  it('returns true when file exists with kind=file', async () => {
    const workDir = setupTempDir();
    writeFileSync(resolve(workDir, 'exists.txt'), 'content');
    const result = await FileExistsCompletion.check(
      { path: 'exists.txt', kind: 'file' },
      makeResult(),
      makeCtx(workDir),
    );
    expect(result).toBe(true);
    cleanupTempDir();
  });

  it('returns false when file does not exist', async () => {
    const workDir = setupTempDir();
    const result = await FileExistsCompletion.check(
      { path: 'missing.txt', kind: 'file' },
      makeResult(),
      makeCtx(workDir),
    );
    expect(result).toBe(false);
    cleanupTempDir();
  });

  it('returns true for dir with kind=dir', async () => {
    const workDir = setupTempDir();
    mkdirSync(resolve(workDir, 'subdir'));
    const result = await FileExistsCompletion.check(
      { path: 'subdir', kind: 'dir' },
      makeResult(),
      makeCtx(workDir),
    );
    expect(result).toBe(true);
    cleanupTempDir();
  });

  it('returns false when kind=file but path is a directory', async () => {
    const workDir = setupTempDir();
    mkdirSync(resolve(workDir, 'subdir'));
    const result = await FileExistsCompletion.check(
      { path: 'subdir', kind: 'file' },
      makeResult(),
      makeCtx(workDir),
    );
    expect(result).toBe(false);
    cleanupTempDir();
  });

  it('returns false when file is smaller than min_size', async () => {
    const workDir = setupTempDir();
    writeFileSync(resolve(workDir, 'small.txt'), 'ab'); // 2 bytes
    const result = await FileExistsCompletion.check(
      { path: 'small.txt', kind: 'file', min_size: 100 },
      makeResult(),
      makeCtx(workDir),
    );
    expect(result).toBe(false);
    cleanupTempDir();
  });

  it('returns true when file meets min_size', async () => {
    const workDir = setupTempDir();
    writeFileSync(resolve(workDir, 'big.txt'), 'a'.repeat(200));
    const result = await FileExistsCompletion.check(
      { path: 'big.txt', kind: 'file', min_size: 100 },
      makeResult(),
      makeCtx(workDir),
    );
    expect(result).toBe(true);
    cleanupTempDir();
  });

  it('kind=any matches both files and directories', async () => {
    const workDir = setupTempDir();
    writeFileSync(resolve(workDir, 'f.txt'), 'data');
    mkdirSync(resolve(workDir, 'd'));
    expect(await FileExistsCompletion.check(
      { path: 'f.txt', kind: 'any' }, makeResult(), makeCtx(workDir),
    )).toBe(true);
    expect(await FileExistsCompletion.check(
      { path: 'd', kind: 'any' }, makeResult(), makeCtx(workDir),
    )).toBe(true);
    cleanupTempDir();
  });
});

// ═══ OutputCheckCompletion ═══

describe('OutputCheckCompletion', () => {
  it('throws when check command is missing', async () => {
    try {
      await OutputCheckCompletion.check({}, makeResult(), makeCtx('/tmp'));
      expect(true).toBe(false);
    } catch (err: unknown) {
      expect((err as Error).message).toContain('"check" is required');
    }
  });

  it('returns true when check command exits 0', async () => {
    const workDir = setupTempDir();
    const result = await OutputCheckCompletion.check(
      { check: 'bun -e "process.exit(0)"' },
      makeResult({ stdout: 'hello' }),
      makeCtx(workDir),
    );
    expect(result).toBe(true);
    cleanupTempDir();
  });

  it('returns false when check command exits non-zero', async () => {
    const workDir = setupTempDir();
    const result = await OutputCheckCompletion.check(
      { check: 'bun -e "process.exit(1)"' },
      makeResult({ stdout: 'hello' }),
      makeCtx(workDir),
    );
    expect(result).toBe(false);
    cleanupTempDir();
  });

  it('pipes task stdout into check command stdin', async () => {
    const workDir = setupTempDir();
    // Use a simple inline bun script to check stdin contains token
    const result = await OutputCheckCompletion.check(
      { check: 'bun -e "const t=await new Response(Bun.stdin.stream()).text();process.exit(t.includes(\'MAGIC_TOKEN\')?0:1)"' },
      makeResult({ stdout: 'before MAGIC_TOKEN after' }),
      makeCtx(workDir),
    );
    expect(result).toBe(true);
    cleanupTempDir();
  });

  it('returns false when token is not in stdout', async () => {
    const workDir = setupTempDir();
    const result = await OutputCheckCompletion.check(
      { check: 'bun -e "const t=await new Response(Bun.stdin.stream()).text();process.exit(t.includes(\'MISSING_TOKEN\')?0:1)"' },
      makeResult({ stdout: 'no match here' }),
      makeCtx(workDir),
    );
    expect(result).toBe(false);
    cleanupTempDir();
  });
});
