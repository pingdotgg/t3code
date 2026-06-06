import {
  PluginId,
  PluginManifest,
  type PluginDiscoveryFailure as PluginDiscoveryFailureType,
  TrimmedNonEmptyString,
  type PluginId as PluginIdType,
  type PluginManifest as PluginManifestType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ServerPlugin } from "./server.ts";

export const PLUGIN_API_VERSION = "0.0.24";

export const PluginPackageJsonConfig = Schema.Struct({
  id: PluginId,
  apiVersion: TrimmedNonEmptyString,
  manifest: TrimmedNonEmptyString,
  server: TrimmedNonEmptyString,
  client: TrimmedNonEmptyString,
});
export type PluginPackageJsonConfig = typeof PluginPackageJsonConfig.Type;

export const PluginPackageJson = Schema.Struct({
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  t3Plugin: PluginPackageJsonConfig,
});
export type PluginPackageJson = typeof PluginPackageJson.Type;

export interface PluginPackageDescriptor {
  readonly pluginId: PluginIdType;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageRoot: string;
  readonly apiVersion: string;
  readonly manifestPath: string;
  readonly serverEntryPath: string;
  readonly clientEntryPath: string;
}

export interface LoadedServerPlugin {
  readonly descriptor: PluginPackageDescriptor;
  readonly manifest: PluginManifestType;
  readonly serverPlugin: ServerPlugin;
}

export interface FailedServerPlugin {
  readonly descriptor: PluginPackageDescriptor;
  readonly manifest: PluginManifestType;
}

export interface FailedPluginDiscovery {
  readonly discovery: PluginDiscoveryFailureType;
}

export function isPluginApiVersionCompatible(apiVersion: string): boolean {
  const normalized = apiVersion.trim();
  return (
    normalized === "*" ||
    normalized === PLUGIN_API_VERSION ||
    normalized === `^${PLUGIN_API_VERSION}`
  );
}

export { PluginManifest };
