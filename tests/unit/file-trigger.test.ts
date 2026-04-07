import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FileTrigger } from '../../src/triggers/file';
import { InMemoryApprovalGateway } from '../../src/approval';
import type { TriggerContext } from '../../src/types';

function makeCtx(workDir: string, signal: AbortSignal): TriggerContext {
  return {
    taskId: 'test_task',
    trackId: 'test_track',
    workDir,
    signal,
    approvalGateway: new InMemoryApprovalGateway(),
  };
}

let tempDir: string;
let controller: AbortController;

beforeEach(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'tagma-file-trigger-'));
  controller = new AbortController();
});

afterEach(() => {
  controller.abort();
  rmSync(tempDir, { recursive: true, force: true });
});

// ═══ ready path — file already exists when watcher initializes ═══

describe('FileTrigger.watch — ready path', () => {
  it('resolves when file already exists at watcher ready time', async () => {
    const filePath = resolve(tempDir, 'existing.txt');
    await Bun.write(filePath, 'pre-existing content');

    const result = await FileTrigger.watch(
      { path: filePath },
      makeCtx(tempDir, controller.signal),
    ) as { path: string };

    expect(result.path).toBe(filePath);
  });
});

// ═══ add path — file created after watcher is established ═══

describe('FileTrigger.watch — add path', () => {
  it('resolves when file is created after watcher starts', async () => {
    const filePath = resolve(tempDir, 'new-file.txt');
    // File does NOT exist yet

    const watchPromise = FileTrigger.watch(
      { path: filePath },
      makeCtx(tempDir, controller.signal),
    ) as Promise<{ path: string }>;

    // Give chokidar enough time to initialize and fire 'ready'
    // (ready finds no file, so no resolution yet)
    await Bun.sleep(400);

    // Create the file — chokidar emits 'add' → watcher resolves
    await Bun.write(filePath, 'new content');

    const result = await watchPromise;
    expect(result.path).toBe(filePath);
  });
});

// ═══ timeout path ═══

describe('FileTrigger.watch — timeout', () => {
  it('rejects with a timeout error when the file never appears', async () => {
    const filePath = resolve(tempDir, 'never-written.txt');

    await expect(
      FileTrigger.watch(
        { path: filePath, timeout: '1s' },
        makeCtx(tempDir, controller.signal),
      ),
    ).rejects.toThrow('file trigger timeout');
  });
});

// ═══ abort path ═══

describe('FileTrigger.watch — abort', () => {
  it('rejects immediately when signal is already aborted before watch starts', async () => {
    controller.abort();
    const filePath = resolve(tempDir, 'never-watched.txt');

    await expect(
      FileTrigger.watch(
        { path: filePath },
        makeCtx(tempDir, controller.signal),
      ),
    ).rejects.toThrow('Pipeline aborted');
  });

  it('rejects when signal is aborted while waiting for the file', async () => {
    const filePath = resolve(tempDir, 'waiting.txt');

    const watchPromise = FileTrigger.watch(
      { path: filePath },
      makeCtx(tempDir, controller.signal),
    );

    // Let watcher initialize, then abort
    await Bun.sleep(150);
    controller.abort();

    await expect(watchPromise).rejects.toThrow('Pipeline aborted');
  });
});

// ═══ config validation ═══

describe('FileTrigger.watch — config validation', () => {
  it('throws synchronously when path is missing from config', () => {
    expect(() => {
      FileTrigger.watch({}, makeCtx(tempDir, controller.signal));
    }).toThrow('"path" is required');
  });
});

// NOTE: The 'change' event branch (src/triggers/file.ts line 62) is not covered here.
// It triggers only when a file exists at watcher start but the 'ready' existence check
// happens to miss it (a timing-sensitive race), and a subsequent write emits 'change'
// instead of 'add'. This is platform-specific behavior (observed when upstream tools
// truncate-and-rewrite a file). It cannot be reliably reproduced in a controlled unit
// test without injecting the existence check. Case 22-file-trigger-change.yaml exercises
// this path end-to-end, but may resolve via the 'ready' or 'add' paths on a given run.
