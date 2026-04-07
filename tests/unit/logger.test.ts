import { describe, it, expect } from 'bun:test';
import { tailLines, clip } from '../../src/logger';

describe('tailLines', () => {
  it('returns last n non-empty lines', () => {
    const text = 'line1\nline2\nline3\nline4\nline5';
    expect(tailLines(text, 3)).toBe('line3\nline4\nline5');
  });

  it('returns all lines when n exceeds line count', () => {
    const text = 'a\nb\nc';
    expect(tailLines(text, 10)).toBe('a\nb\nc');
  });

  it('returns empty string for empty input', () => {
    expect(tailLines('', 5)).toBe('');
  });

  it('filters out empty lines', () => {
    const text = 'a\n\nb\n\nc\n';
    expect(tailLines(text, 2)).toBe('b\nc');
  });

  it('handles single line', () => {
    expect(tailLines('only', 3)).toBe('only');
  });

  it('handles Windows line endings', () => {
    const text = 'line1\r\nline2\r\nline3';
    expect(tailLines(text, 2)).toBe('line2\nline3');
  });
});

describe('clip', () => {
  it('returns text unchanged when within limit', () => {
    expect(clip('hello', 100)).toBe('hello');
  });

  it('returns empty string for empty input', () => {
    expect(clip('', 100)).toBe('');
  });

  it('truncates long ASCII text and appends marker', () => {
    const text = 'a'.repeat(200);
    const result = clip(text, 100);
    expect(result.length).toBeLessThan(250); // truncated + marker
    expect(result).toContain('…[truncated 100 bytes]');
  });

  it('counts multi-byte characters correctly', () => {
    // Each CJK character is 3 bytes in UTF-8
    const text = '你好世界'; // 4 chars = 12 bytes
    const result = clip(text, 6); // allow only 6 bytes = 2 CJK chars
    expect(result).toContain('truncated');
    expect(result).toContain('6 bytes');
  });

  it('counts emoji correctly (4 bytes each)', () => {
    const text = '😀😁😂🤣'; // 4 emoji = 16 bytes
    const result = clip(text, 8);
    expect(result).toContain('truncated');
    expect(result).toContain('8 bytes');
  });

  it('uses default maxBytes of 16KB', () => {
    const small = 'x'.repeat(100);
    expect(clip(small)).toBe(small);

    const big = 'x'.repeat(20_000);
    const result = clip(big);
    expect(result).toContain('truncated');
  });

  it('handles exact boundary (no truncation)', () => {
    const text = 'abc'; // 3 bytes
    expect(clip(text, 3)).toBe('abc');
  });
});
