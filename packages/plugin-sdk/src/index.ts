/** Hosts and source plugins share this exact identity helper. */
export { definePlugin } from "@t3tools/shared/pluginRuntime";
export type {
  PluginDisposer,
  ClientPluginServices,
  PluginServices,
  PluginContributionMetadata,
} from "./common.ts";
export type { PluginManifest } from "@t3tools/contracts";
export type {
  PluginServiceDefinition,
  PluginServiceFactory,
  PluginServiceFactoryContext,
  PluginServiceWrapper,
} from "@t3tools/shared/pluginKernel";
