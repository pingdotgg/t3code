/**
 * Neutral list of enabled, user-configured MCP servers for a session start,
 * plus small shape-conversion primitives. Every provider adapter
 * (Claude/Codex/Grok/Cursor/OpenCode) merges this list into its own
 * `mcpServers` wiring, alongside T3's built-in "t3-code" server (see
 * `McpProviderSession.ts`) — each in its own vendor-specific shape, since
 * Claude's SDK, Codex's CLI flags, ACP (Grok/Cursor), and OpenCode's SDK
 * each want a genuinely different wire format.
 *
 * @module resolveSessionMcpServers
 */
import type { McpServerConfig, McpServerEnvVars, McpServerHeaders } from "@t3tools/contracts";

import { readEnabledMcpServers } from "./UserMcpServers.ts";

export interface ResolvedMcpServer {
  /**
   * Unique, human-readable key for this server — its display name,
   * disambiguated with a short id suffix if two enabled servers share a
   * name. Used as the tool-source name vendors show the model.
   */
  readonly key: string;
  readonly config: McpServerConfig;
}

/** Resolves the enabled user-configured MCP servers with unique display keys. */
export function resolveSessionMcpServers(): ReadonlyArray<ResolvedMcpServer> {
  const servers = readEnabledMcpServers();
  const nameCounts = new Map<string, number>();
  for (const server of servers) {
    nameCounts.set(server.config.name, (nameCounts.get(server.config.name) ?? 0) + 1);
  }
  return servers.map((server) => {
    const isDuplicateName = (nameCounts.get(server.config.name) ?? 0) > 1;
    const key = isDuplicateName
      ? `${server.config.name}-${server.id.slice(0, 8)}`
      : server.config.name;
    return { key, config: server.config };
  });
}

/** `McpServerEnvVar[]` → plain `Record<string, string>`, as every vendor SDK expects. */
export function mcpEnvRecord(env: McpServerEnvVars | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const variable of env ?? []) {
    record[variable.name] = variable.value;
  }
  return record;
}

/** `McpServerHeader[]` → plain `Record<string, string>`, as every vendor SDK expects. */
export function mcpHeaderRecord(headers: McpServerHeaders | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const header of headers ?? []) {
    record[header.name] = header.value;
  }
  return record;
}
