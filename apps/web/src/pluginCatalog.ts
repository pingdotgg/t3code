import type { PluginCatalog, PluginCatalogEntry, PluginViewCommand } from "@t3tools/contracts";

export interface PluginPageContribution {
  readonly plugin: PluginCatalogEntry;
  readonly command: PluginViewCommand;
}

export function pluginPageContributions(catalog: PluginCatalog): PluginPageContribution[] {
  return catalog.plugins.flatMap((plugin) =>
    plugin.enabled ? plugin.commands.map((command) => ({ plugin, command })) : [],
  );
}

export function findPluginPage(
  catalog: PluginCatalog,
  pluginId: string,
  commandName: string,
): PluginPageContribution | null {
  return (
    pluginPageContributions(catalog).find(
      (page) => page.plugin.id === pluginId && page.command.name === commandName,
    ) ?? null
  );
}
