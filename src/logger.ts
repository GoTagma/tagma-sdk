import { resolve, dirname } from 'node:path';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';

/**
 * Dual-channel logger.
 *
 *   - `info/warn/error` → console AND file (brief, user-visible events)
 *   - `debug`           → file ONLY (verbose diagnostics)
 *   - `section`         → file ONLY (visual separators)
 *   - `quiet`           → file ONLY (bulk payload like full stdout dumps)
 *
 * Log file path: <workDir>/tmp/pipeline.log (one file per pipeline run,
 * truncated on construction).
 */
export class Logger {
  private readonly filePath: string;
  private readonly runDir: string;

  constructor(workDir: string, runId: string) {
    this.runDir = resolve(workDir, 'logs', runId);
    this.filePath = resolve(this.runDir, 'pipeline.log');
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      `# Pipeline run ${runId} @ ${new Date().toISOString()}\n` +
      `# Host: ${process.platform} ${process.arch}  Bun: ${process.versions.bun ?? 'n/a'}\n` +
      `# Work dir: ${workDir}\n\n`,
    );
  }

  info(prefix: string, message: string): void {
    const line = `${timestamp()} ${prefix} ${message}`;
    console.log(line);
    this.append(line);
  }

  warn(prefix: string, message: string): void {
    const line = `${timestamp()} ${prefix} WARN: ${message}`;
    console.warn(line);
    this.append(line);
  }

  error(prefix: string, message: string): void {
    const line = `${timestamp()} ${prefix} ERROR: ${message}`;
    console.error(line);
    this.append(line);
  }

  /** File-only diagnostic log line. */
  debug(prefix: string, message: string): void {
    this.append(`${timestamp()} ${prefix} DEBUG: ${message}`);
  }

  /** File-only visual separator with title. */
  section(title: string): void {
    this.append(`\n━━━ ${title} ━━━`);
  }

  /** File-only bulk payload (e.g. full stdout / stderr dumps). */
  quiet(message: string): void {
    this.append(message);
  }

  private append(line: string): void {
    try {
      appendFileSync(this.filePath, line.endsWith('\n') ? line : line + '\n');
    } catch {
      // Swallow log write failures; engine correctness shouldn't depend on logging.
    }
  }

  get path(): string {
    return this.filePath;
  }

  /** Directory that holds all artifacts for this run (pipeline.log, *.stderr, etc.). */
  get dir(): string {
    return this.runDir;
  }
}

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Return the last `n` non-empty lines of `text`, joined with newlines. */
export function tailLines(text: string, n: number): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  return lines.slice(-n).join('\n');
}

/**
 * Truncate a blob to at most `maxBytes` UTF-8 bytes for log embedding,
 * appending a marker when truncation occurred.
 */
export function clip(text: string, maxBytes = 16 * 1024): string {
  if (!text) return '';
  if (text.length <= maxBytes) return text;
  const omitted = text.length - maxBytes;
  return text.slice(0, maxBytes) + `\n…[truncated ${omitted} chars]`;
}
