import { describe, it, expect } from 'bun:test';
import { resolve } from 'path';
import { parseDuration, validatePath, truncateForName } from '../../src/utils';

// ═══ parseDuration ═══

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('5s')).toBe(5000);
    expect(parseDuration('1s')).toBe(1000);
    expect(parseDuration('0s')).toBe(0);
  });

  it('parses minutes', () => {
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('10m')).toBe(600_000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('parses decimal values', () => {
    expect(parseDuration('0.5s')).toBe(500);
    expect(parseDuration('1.5m')).toBe(90_000);
    expect(parseDuration('0.25h')).toBe(900_000);
  });

  it('trims whitespace', () => {
    expect(parseDuration('  3s  ')).toBe(3000);
  });

  it('throws on milliseconds (unsupported unit)', () => {
    expect(() => parseDuration('500ms')).toThrow('Invalid duration');
  });

  it('throws on days (unsupported unit)', () => {
    expect(() => parseDuration('5d')).toThrow('Invalid duration');
  });

  it('throws on bare number without unit', () => {
    expect(() => parseDuration('100')).toThrow('Invalid duration');
  });

  it('throws on empty string', () => {
    expect(() => parseDuration('')).toThrow('Invalid duration');
  });

  it('throws on non-numeric prefix', () => {
    expect(() => parseDuration('abcs')).toThrow('Invalid duration');
  });
});

// ═══ validatePath ═══

describe('validatePath', () => {
  // Use a platform-safe root for all tests
  const root = resolve('/tmp/project-root');

  it('resolves a simple relative path within root', () => {
    const result = validatePath('subdir/file.txt', root);
    expect(result).toBe(resolve(root, 'subdir/file.txt'));
  });

  it('resolves nested relative path', () => {
    const result = validatePath('a/b/c.txt', root);
    expect(result).toBe(resolve(root, 'a/b/c.txt'));
  });

  it('allows .. that stays within root', () => {
    // subdir/../file.txt collapses to file.txt — still within root
    const result = validatePath('subdir/../file.txt', root);
    expect(result).toBe(resolve(root, 'file.txt'));
  });

  it('throws on .. traversal that escapes root', () => {
    expect(() => validatePath('../../etc/passwd', root)).toThrow('Security');
  });

  it('throws on leading .. that escapes root', () => {
    expect(() => validatePath('../outside.txt', root)).toThrow('Security');
  });

  it('allows a bare filename (no subdirectory)', () => {
    const result = validatePath('file.txt', root);
    expect(result).toBe(resolve(root, 'file.txt'));
  });
});

// ═══ truncateForName ═══

describe('truncateForName', () => {
  it('returns short text unchanged', () => {
    expect(truncateForName('hello')).toBe('hello');
  });

  it('truncates long text with ellipsis', () => {
    const long = 'x'.repeat(50);
    const result = truncateForName(long, 10);
    expect(result).toBe('x'.repeat(10) + '...');
    expect(result.length).toBe(13); // 10 + '...'
  });

  it('uses first line of multiline text', () => {
    expect(truncateForName('first line\nsecond\nthird')).toBe('first line');
  });

  it('falls back to trimmed raw text when first line is empty', () => {
    expect(truncateForName('\n\nhello')).toBe('hello');
  });

  it('returns "..." for whitespace-only input', () => {
    expect(truncateForName('   \n   ')).toBe('...');
  });

  it('defaults maxLen to 40', () => {
    const exactly40 = 'a'.repeat(40);
    expect(truncateForName(exactly40)).toBe(exactly40); // exactly at limit — no truncation
    const over40 = 'a'.repeat(41);
    expect(truncateForName(over40)).toBe('a'.repeat(40) + '...');
  });
});
