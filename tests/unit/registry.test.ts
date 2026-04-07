import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  registerPlugin, getHandler, hasHandler, listRegistered, loadPlugins,
} from '../../src/registry';
import type { CompletionPlugin } from '../../src/types';

// ── Fake completion plugin ──

const fakeCompletion: CompletionPlugin = {
  name: 'fake-check',
  async check() { return true; },
};

describe('registerPlugin + getHandler', () => {
  it('registers and retrieves a plugin', () => {
    registerPlugin('completions', 'fake-check', fakeCompletion);
    const handler = getHandler<CompletionPlugin>('completions', 'fake-check');
    expect(handler.name).toBe('fake-check');
  });

  it('is idempotent — duplicate registration does not throw', () => {
    registerPlugin('completions', 'fake-check', fakeCompletion);
    registerPlugin('completions', 'fake-check', fakeCompletion);
    expect(hasHandler('completions', 'fake-check')).toBe(true);
  });

  it('throws for unregistered plugin type', () => {
    expect(() => getHandler('completions', 'nonexistent-plugin')).toThrow('not registered');
  });
});

describe('hasHandler', () => {
  it('returns true for registered plugin', () => {
    registerPlugin('completions', 'has-test', fakeCompletion);
    expect(hasHandler('completions', 'has-test')).toBe(true);
  });

  it('returns false for unregistered plugin', () => {
    expect(hasHandler('completions', 'nope-does-not-exist')).toBe(false);
  });
});

describe('listRegistered', () => {
  it('includes registered plugin names', () => {
    registerPlugin('completions', 'list-test', fakeCompletion);
    const names = listRegistered('completions');
    expect(names).toContain('list-test');
  });
});

describe('loadPlugins', () => {
  // Mock a package that exports the required plugin contract
  mock.module('@tagma/completions-mock-plugin', () => ({
    pluginCategory: 'completions',
    pluginType: 'mock-loaded',
    default: {
      name: 'mock-loaded',
      async check() { return false; },
    } satisfies CompletionPlugin,
  }));

  it('dynamically loads and registers a plugin package', async () => {
    await loadPlugins(['@tagma/completions-mock-plugin']);
    expect(hasHandler('completions', 'mock-loaded')).toBe(true);
    const handler = getHandler<CompletionPlugin>('completions', 'mock-loaded');
    expect(handler.name).toBe('mock-loaded');
  });

  // Mock a bad module missing required exports
  mock.module('@tagma/bad-plugin', () => ({
    default: { name: 'bad' },
    // missing pluginCategory and pluginType
  }));

  it('throws when plugin is missing required exports', async () => {
    await expect(loadPlugins(['@tagma/bad-plugin'])).rejects.toThrow('must export');
  });
});
