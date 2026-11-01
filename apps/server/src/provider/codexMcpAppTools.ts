import type { ProviderAdapterV2McpTool } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Predicate from "effect/Predicate";

function appToolIdentity(tool: ProviderAdapterV2McpTool | undefined) {
  const meta = tool?._meta;
  if (!Predicate.isObject(meta) || !Predicate.isObject(meta._codex_apps)) return undefined;
  const connectorId = meta.connector_id;
  const linkId = meta.link_id;
  const uri = meta._codex_apps.resource_uri;
  if (
    typeof connectorId !== "string" ||
    connectorId === "" ||
    typeof linkId !== "string" ||
    linkId === "" ||
    typeof uri !== "string"
  )
    return undefined;
  const parts = uri.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== connectorId || parts[2] !== linkId) {
    return undefined;
  }
  const name = parts[3];
  if (!name || !/^[\w.-]+$/.test(name)) return undefined;
  return { connectorId, linkId, name };
}

export function codexMcpAppTools(
  tools: ReadonlyArray<ProviderAdapterV2McpTool>,
  sourceTool: string,
): ReadonlyArray<ProviderAdapterV2McpTool> {
  const source = appToolIdentity(tools.find((tool) => tool.name === sourceTool));
  if (source === undefined) return tools;
  return tools.map((tool) => {
    const identity = appToolIdentity(tool);
    // Hosted apps call their original tool names, before Codex adds a namespace.
    // Only the originating app/account can supply those unqualified names.
    return identity?.connectorId === source.connectorId && identity.linkId === source.linkId
      ? { ...tool, appToolName: identity.name }
      : tool;
  });
}
