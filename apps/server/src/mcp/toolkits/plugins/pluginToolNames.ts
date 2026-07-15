import type { PluginId } from "@t3tools/contracts/plugin";

/** Local tool names declared by plugins (host applies the namespace). */
export const PLUGIN_TOOL_LOCAL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * Final MCP tool name:
 * `plugin_<pluginId_with_dashes_to_underscores>__<localName>`.
 *
 * PluginId forbids `_` (`[a-z][a-z0-9-]{1,40}`), so dash→underscore cannot
 * collide across plugin ids.
 */
export const pluginToolFinalName = (pluginId: PluginId, localName: string): string =>
  `plugin_${pluginId.replaceAll("-", "_")}__${localName}`;

export const isValidPluginToolLocalName = (name: string): boolean =>
  PLUGIN_TOOL_LOCAL_NAME_PATTERN.test(name);
