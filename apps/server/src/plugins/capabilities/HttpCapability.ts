import type { PluginId } from "@t3tools/contracts/plugin";
import type { HttpCapability } from "@t3tools/plugin-sdk";

export function makeHttpCapability(pluginId: PluginId): HttpCapability {
  return {
    basePath: `/hooks/plugins/${pluginId}`,
  };
}
