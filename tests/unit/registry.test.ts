import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  registerPlugin,
  unregisterPlugin,
  getHandler,
  hasHandler,
  listRegistered,
  loadPlugins,
  isValidPluginName,
  PLUGIN_NAME_RE,
  readPluginManifest,
} from '../../src/registry';
import type {
  CompletionPlugin,
  DriverPlugin,
  TriggerPlugin,
  MiddlewarePlugin,
} from '../../src/types';

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

  it('rejects non-scoped / path-like plugin names', async () => {
    await expect(loadPlugins(['./relative/plugin'])).rejects.toThrow('rejected');
    await expect(loadPlugins(['../up/plugin'])).rejects.toThrow('rejected');
    await expect(loadPlugins(['C:\\abs\\plugin'])).rejects.toThrow('rejected');
    await expect(loadPlugins(['randomname'])).rejects.toThrow('rejected');
  });
});

// ── Return-value contract ──

describe('registerPlugin return value', () => {
  const handlerA: CompletionPlugin = { name: 'ret-a', async check() { return true; } };
  const handlerB: CompletionPlugin = { name: 'ret-a', async check() { return false; } };

  beforeEach(() => {
    unregisterPlugin('completions', 'ret-a');
  });

  it('returns "registered" on first registration', () => {
    expect(registerPlugin('completions', 'ret-a', handlerA)).toBe('registered');
  });

  it('returns "unchanged" when the same handler instance is re-registered', () => {
    registerPlugin('completions', 'ret-a', handlerA);
    expect(registerPlugin('completions', 'ret-a', handlerA)).toBe('unchanged');
  });

  it('returns "replaced" when a different handler overwrites an existing entry', () => {
    registerPlugin('completions', 'ret-a', handlerA);
    expect(registerPlugin('completions', 'ret-a', handlerB)).toBe('replaced');
    expect(getHandler<CompletionPlugin>('completions', 'ret-a')).toBe(handlerB);
  });
});

// ── Input validation ──

describe('registerPlugin input validation', () => {
  const valid: CompletionPlugin = { name: 'iv', async check() { return true; } };

  it('throws for unknown category', () => {
    // @ts-expect-error — deliberately invalid category
    expect(() => registerPlugin('nonsense', 'x', valid)).toThrow('Unknown plugin category');
  });

  it('throws for empty type', () => {
    expect(() => registerPlugin('completions', '', valid)).toThrow('non-empty string');
  });

  it('throws when handler is not an object', () => {
    // @ts-expect-error — deliberately invalid handler
    expect(() => registerPlugin('completions', 'bad', null)).toThrow('must be an object');
    // @ts-expect-error — deliberately invalid handler
    expect(() => registerPlugin('completions', 'bad', 42)).toThrow('must be an object');
  });

  it('throws when handler has no name', () => {
    // @ts-expect-error — deliberately missing name
    expect(() => registerPlugin('completions', 'bad', { async check() { return true; } }))
      .toThrow('non-empty "name"');
  });
});

// ── Contract validation per category ──

describe('registerPlugin contract validation', () => {
  it('rejects drivers missing buildCommand', () => {
    const bad = { name: 'bad-drv', capabilities: {} } as unknown as DriverPlugin;
    expect(() => registerPlugin('drivers', 'bad-drv', bad))
      .toThrow('must export buildCommand');
  });

  it('rejects drivers missing capabilities', () => {
    const bad = { name: 'bad-drv', buildCommand: async () => ({} as any) } as unknown as DriverPlugin;
    expect(() => registerPlugin('drivers', 'bad-drv', bad))
      .toThrow('must declare capabilities');
  });

  it('rejects triggers missing watch()', () => {
    const bad = { name: 'bad-trg' } as unknown as TriggerPlugin;
    expect(() => registerPlugin('triggers', 'bad-trg', bad))
      .toThrow('must export watch');
  });

  it('rejects completions missing check()', () => {
    const bad = { name: 'bad-cmp' } as unknown as CompletionPlugin;
    expect(() => registerPlugin('completions', 'bad-cmp', bad))
      .toThrow('must export check');
  });

  it('rejects middlewares missing enhance()', () => {
    const bad = { name: 'bad-mw' } as unknown as MiddlewarePlugin;
    expect(() => registerPlugin('middlewares', 'bad-mw', bad))
      .toThrow('must export enhance');
  });
});

// ── unregisterPlugin ──

describe('unregisterPlugin', () => {
  const handler: CompletionPlugin = { name: 'unreg', async check() { return true; } };

  it('removes a registered plugin and returns true', () => {
    registerPlugin('completions', 'unreg', handler);
    expect(hasHandler('completions', 'unreg')).toBe(true);
    expect(unregisterPlugin('completions', 'unreg')).toBe(true);
    expect(hasHandler('completions', 'unreg')).toBe(false);
  });

  it('returns false when the plugin is not registered', () => {
    expect(unregisterPlugin('completions', 'never-was-here')).toBe(false);
  });

  it('returns false for unknown category', () => {
    // @ts-expect-error — deliberately invalid category
    expect(unregisterPlugin('nonsense', 'x')).toBe(false);
  });
});

// ── isValidPluginName / PLUGIN_NAME_RE ──

describe('isValidPluginName', () => {
  it('accepts scoped @tagma/* packages', () => {
    expect(isValidPluginName('@tagma/driver-codex')).toBe(true);
    expect(isValidPluginName('@tagma/trigger-file')).toBe(true);
  });

  it('accepts tagma-plugin-* packages', () => {
    expect(isValidPluginName('tagma-plugin-foo')).toBe(true);
    expect(isValidPluginName('tagma-plugin-foo.bar_1')).toBe(true);
  });

  it('rejects path-like names', () => {
    expect(isValidPluginName('./local')).toBe(false);
    expect(isValidPluginName('../up')).toBe(false);
    expect(isValidPluginName('C:\\abs')).toBe(false);
    expect(isValidPluginName('/etc/passwd')).toBe(false);
  });

  it('accepts any scoped package (regex is not restricted to @tagma)', () => {
    expect(isValidPluginName('@other/pkg')).toBe(true);
  });

  it('rejects unscoped / random package names', () => {
    expect(isValidPluginName('lodash')).toBe(false);
    expect(isValidPluginName('')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidPluginName(undefined)).toBe(false);
    expect(isValidPluginName(null)).toBe(false);
    expect(isValidPluginName(42)).toBe(false);
  });

  it('PLUGIN_NAME_RE is exported and matches the same rules', () => {
    expect(PLUGIN_NAME_RE.test('@tagma/driver-codex')).toBe(true);
    expect(PLUGIN_NAME_RE.test('./local')).toBe(false);
  });
});

// ── readPluginManifest ──
//
// The `tagmaPlugin` package.json field is the canonical signal that an
// installed package is a tagma plugin. These tests cover the parser
// contract that hosts rely on for auto-discovery.

describe('readPluginManifest', () => {
  it('returns null when tagmaPlugin field is absent', () => {
    expect(readPluginManifest({ name: '@tagma/sdk', version: '0.3.8' })).toBeNull();
    expect(readPluginManifest({})).toBeNull();
  });

  it('returns null for non-object input (defensive)', () => {
    expect(readPluginManifest(null)).toBeNull();
    expect(readPluginManifest(undefined)).toBeNull();
    expect(readPluginManifest('not a package json')).toBeNull();
    expect(readPluginManifest(42)).toBeNull();
  });

  it('parses a well-formed manifest for each category', () => {
    expect(readPluginManifest({
      tagmaPlugin: { category: 'drivers', type: 'codex' },
    })).toEqual({ category: 'drivers', type: 'codex' });

    expect(readPluginManifest({
      tagmaPlugin: { category: 'triggers', type: 'github' },
    })).toEqual({ category: 'triggers', type: 'github' });

    expect(readPluginManifest({
      tagmaPlugin: { category: 'completions', type: 'output_check' },
    })).toEqual({ category: 'completions', type: 'output_check' });

    expect(readPluginManifest({
      tagmaPlugin: { category: 'middlewares', type: 'static_context' },
    })).toEqual({ category: 'middlewares', type: 'static_context' });
  });

  it('throws when category is missing or not one of the four', () => {
    expect(() => readPluginManifest({
      tagmaPlugin: { type: 'codex' },
    })).toThrow(/category/);
    expect(() => readPluginManifest({
      tagmaPlugin: { category: 'driver', type: 'codex' }, // singular!
    })).toThrow(/category/);
    expect(() => readPluginManifest({
      tagmaPlugin: { category: 'plugins', type: 'codex' },
    })).toThrow(/category/);
  });

  it('throws when type is missing or empty', () => {
    expect(() => readPluginManifest({
      tagmaPlugin: { category: 'drivers' },
    })).toThrow(/type/);
    expect(() => readPluginManifest({
      tagmaPlugin: { category: 'drivers', type: '' },
    })).toThrow(/type/);
    expect(() => readPluginManifest({
      tagmaPlugin: { category: 'drivers', type: 42 },
    })).toThrow(/type/);
  });

  it('throws when tagmaPlugin field is present but not an object', () => {
    expect(() => readPluginManifest({ tagmaPlugin: true })).toThrow(/object/);
    expect(() => readPluginManifest({ tagmaPlugin: 'codex' })).toThrow(/object/);
    expect(() => readPluginManifest({ tagmaPlugin: null })).toThrow(/object/);
  });
});
