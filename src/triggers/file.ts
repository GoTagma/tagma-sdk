import { watch } from 'chokidar';
import { resolve, dirname } from 'path';
import type { TriggerPlugin, TriggerContext } from '../types';
import { parseDuration, validatePath } from '../utils';

const IS_WINDOWS = process.platform === 'win32';

function pathsEqual(a: string, b: string): boolean {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export const FileTrigger: TriggerPlugin = {
  name: 'file',

  watch(config: Record<string, unknown>, ctx: TriggerContext): Promise<unknown> {
    const filePath = config.path as string;
    if (!filePath) throw new Error(`file trigger: "path" is required`);

    const safePath = validatePath(filePath, ctx.workDir);
    const timeoutMs = config.timeout != null ? parseDuration(String(config.timeout)) : 0;

    return new Promise((resolve_p, reject) => {
      if (ctx.signal.aborted) {
        reject(new Error('Pipeline aborted'));
        return;
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const dir = dirname(safePath);
      const watcher = watch(dir, {
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      });

      const cleanup = () => {
        if (settled) return;
        settled = true;
        watcher.close().catch(() => { /* ignore */ });
        if (timer) clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        cleanup();
        reject(new Error('Pipeline aborted'));
      };

      watcher.on('add', (addedPath: string) => {
        if (settled) return;
        if (pathsEqual(resolve(addedPath), safePath)) {
          cleanup();
          resolve_p({ path: safePath });
        }
      });

      // Also fire on 'change' so that overwriting an existing file is detected.
      // Without this, upstream tasks that truncate-and-rewrite a file emit only
      // a 'change' event and the downstream trigger would never resolve.
      watcher.on('change', (changedPath: string) => {
        if (settled) return;
        if (pathsEqual(resolve(changedPath), safePath)) {
          cleanup();
          resolve_p({ path: safePath });
        }
      });

      watcher.on('error', (err: unknown) => {
        if (settled) return;
        cleanup();
        reject(new Error(`file trigger watch error: ${err instanceof Error ? err.message : String(err)}`));
      });

      // After the watcher finishes its initial scan, check if the file already exists.
      // Doing this inside 'ready' eliminates the race window between existence check
      // and watcher startup, so we neither miss events nor double-resolve.
      watcher.on('ready', () => {
        if (settled) return;
        Bun.file(safePath).exists().then((exists) => {
          if (settled) return;
          if (exists) {
            cleanup();
            resolve_p({ path: safePath });
          }
        }).catch((err: unknown) => {
          if (settled) return;
          cleanup();
          reject(new Error(`file trigger existence check failed: ${err instanceof Error ? err.message : String(err)}`));
        });
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          cleanup();
          reject(new Error(`file trigger timeout: ${filePath} did not appear within ${config.timeout}`));
        }, timeoutMs);
      }

      ctx.signal.addEventListener('abort', onAbort);
    });
  },
};
