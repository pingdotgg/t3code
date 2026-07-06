import type { PluginId } from "@t3tools/contracts/plugin";

export const pluginsRoot = (
  stateDir: string,
  join: (...segments: ReadonlyArray<string>) => string,
) => join(stateDir, "plugins");

export const pluginVersionDir = (
  root: string,
  id: PluginId | string,
  version: string,
  join: (...segments: ReadonlyArray<string>) => string,
) => join(root, id, version);

export const pluginDataDir = (
  root: string,
  id: PluginId | string,
  join: (...segments: ReadonlyArray<string>) => string,
) => join(root, id, "data");

export const pluginManifestPath = (
  pluginDir: string,
  join: (...segments: ReadonlyArray<string>) => string,
) => join(pluginDir, "manifest.json");

export const pluginLockfilePath = (
  root: string,
  join: (...segments: ReadonlyArray<string>) => string,
) => join(root, "plugins.json");

export const pluginAdvisoryLockPath = (
  root: string,
  join: (...segments: ReadonlyArray<string>) => string,
) => join(root, "plugins.json.lock");
