import type {
  PluginCategory, DriverPlugin, TriggerPlugin,
  CompletionPlugin, MiddlewarePlugin,
} from './types';

type PluginType = DriverPlugin | TriggerPlugin | CompletionPlugin | MiddlewarePlugin;

const registries = {
  drivers:     new Map<string, DriverPlugin>(),
  triggers:    new Map<string, TriggerPlugin>(),
  completions: new Map<string, CompletionPlugin>(),
  middlewares: new Map<string, MiddlewarePlugin>(),
};

export function registerPlugin<T extends PluginType>(
  category: PluginCategory, type: string, handler: T,
): void {
  const registry = registries[category] as Map<string, T>;
  if (registry.has(type)) return; // idempotent — skip duplicate registration
  registry.set(type, handler);
}

export function getHandler<T extends PluginType>(
  category: PluginCategory, type: string,
): T {
  const handler = registries[category].get(type);
  if (!handler) {
    throw new Error(
      `${category} type "${type}" not registered.\n` +
      `Install the plugin: bun add @tagma/${category.replace(/s$/, '')}-${type}`
    );
  }
  return handler as T;
}

export function hasHandler(category: PluginCategory, type: string): boolean {
  return registries[category].has(type);
}

export async function loadPlugins(pluginNames: readonly string[]): Promise<void> {
  for (const name of pluginNames) {
    const mod = await import(name);
    if (!mod.pluginCategory || !mod.pluginType || !mod.default) {
      throw new Error(
        `Plugin "${name}" must export pluginCategory, pluginType, and default`
      );
    }
    registerPlugin(mod.pluginCategory, mod.pluginType, mod.default);
  }
}

export function listRegistered(category: PluginCategory): string[] {
  return [...registries[category].keys()];
}
