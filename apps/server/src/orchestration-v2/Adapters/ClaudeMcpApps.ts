import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { MCP_APP_RESOURCE_SCHEME } from "@t3tools/shared/mcpApp";
import * as Predicate from "effect/Predicate";

type ClaudeMcpStatusTool = NonNullable<McpServerStatus["tools"]>[number];

export interface ClaudeMcpAppTarget {
  /** The server's configured name, which Claude Code's MCP requests take. */
  readonly server: string;
  readonly tool: string;
  readonly resourceUri: string;
}

// Claude Code replaces characters outside [a-zA-Z0-9_-] in both names.
const normalizeClaudeMcpName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");

const claudeMcpToolName = (server: string, tool: string) =>
  `mcp__${normalizeClaudeMcpName(server)}__${normalizeClaudeMcpName(tool)}`;

function claudeMcpAppResourceUri(tool: ClaudeMcpStatusTool): string | undefined {
  const ui = Predicate.isObject(tool._meta) ? tool._meta.ui : undefined;
  const uri =
    Predicate.isObject(ui) && typeof ui.resourceUri === "string"
      ? ui.resourceUri
      : tool._meta?.["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME) ? uri : undefined;
}

/**
 * Apps by native tool name. Normalization can map two tools to one name;
 * those calls stay plain rows (null), like tools without an app.
 */
export function claudeMcpAppTargets(
  statuses: ReadonlyArray<McpServerStatus>,
): Map<string, ClaudeMcpAppTarget | null> {
  const targets = new Map<string, ClaudeMcpAppTarget | null>();
  for (const server of statuses) {
    for (const tool of server.tools ?? []) {
      const name = claudeMcpToolName(server.name, tool.name);
      const resourceUri = claudeMcpAppResourceUri(tool);
      targets.set(
        name,
        targets.has(name) || resourceUri === undefined
          ? null
          : { server: server.name, tool: tool.name, resourceUri },
      );
    }
  }
  return targets;
}

/**
 * The native name of one tool, unless normalization gives another configured tool the same
 * name: Claude Code could then run either.
 */
export function uniqueClaudeMcpToolName(
  statuses: ReadonlyArray<McpServerStatus>,
  server: string,
  tool: string,
): string | undefined {
  const name = claudeMcpToolName(server, tool);
  const owners = statuses.flatMap((status) =>
    (status.tools ?? []).flatMap((candidate) =>
      claudeMcpToolName(status.name, candidate.name) === name
        ? [{ server: status.name, tool: candidate.name }]
        : [],
    ),
  );
  return owners.length === 1 && owners[0]!.server === server && owners[0]!.tool === tool
    ? name
    : undefined;
}

/**
 * The status has no input schema, so apps get MCP's minimal one and must not rely on it.
 * Annotations are left out: calls outside a turn skip Claude's permission rules, so T3 asks every time.
 */
export function claudeMcpToolsForApps(
  server: McpServerStatus,
): ReadonlyArray<ProviderAdapter.ProviderAdapterV2McpTool> {
  return (server.tools ?? []).map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: { type: "object" },
    ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
  }));
}

function mcpContentBlocks(content: unknown): ReadonlyArray<unknown> | undefined {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return undefined;
  return content.flatMap((block): ReadonlyArray<unknown> => {
    if (!Predicate.isObject(block)) return [];
    if (block.type === "image" && Predicate.isObject(block.source)) {
      const { source } = block;
      return source.type === "base64" &&
        typeof source.data === "string" &&
        typeof source.media_type === "string"
        ? [{ type: "image", data: source.data, mimeType: source.media_type }]
        : [];
    }
    return typeof block.type === "string" ? [block] : [];
  });
}

/**
 * Claude Code hands an MCP Apps tool's own result to hosts as `tool_use_result` (content as
 * blocks or one string, beside structuredContent and _meta); otherwise only the model-facing
 * `tool_result` content survives. Image blocks in Anthropic's shape become MCP image blocks.
 */
export function claudeMcpCallToolResult(input: {
  readonly native: unknown;
  readonly fallbackContent?: unknown;
  readonly isError: boolean;
}): ProviderAdapter.ProviderAdapterV2McpCallToolResult {
  const native = Predicate.isObject(input.native) ? input.native : undefined;
  const nativeContent = native === undefined ? undefined : mcpContentBlocks(native.content);
  const content = nativeContent ?? mcpContentBlocks(input.fallbackContent) ?? [];
  return {
    content,
    ...(nativeContent === undefined || native?.structuredContent === undefined
      ? {}
      : { structuredContent: native.structuredContent }),
    ...(nativeContent === undefined || native?._meta === undefined ? {} : { _meta: native._meta }),
    ...(input.isError ? { isError: true } : {}),
  };
}
