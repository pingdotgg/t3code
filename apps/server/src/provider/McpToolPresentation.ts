import type {
  ThreadId,
  ToolActivityIcon,
  ToolActivitySource,
  ToolActivitySurface,
} from "@t3tools/contracts";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";

import {
  cuaToolPresentation,
  isCuaServerName,
  rememberCuaToolResult,
} from "../cua/cuaToolPresentation.ts";

export function normalizeMcpText(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/gu, " ");
  return text.length > 0 && text.length <= maxLength ? text : undefined;
}

export function normalizeMcpHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.href.length <= 4096
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function mcpToolPresentation(input: {
  readonly toolName?: unknown;
  readonly serverName?: unknown;
  readonly title?: unknown;
  readonly serverDisplayName?: unknown;
  readonly iconUrl?: unknown;
  readonly iconUrlDark?: unknown;
  readonly source?: unknown;
  /**
   * The app thread, so Cua Driver calls can name the app the agent drives:
   * Cua addresses apps by pid, which earlier calls in the thread resolved.
   */
  readonly threadId?: ThreadId | null;
  /** The call's arguments, which carry that pid or app. */
  readonly args?: unknown;
  readonly status?: "inProgress" | "completed" | "failed";
}): {
  readonly title?: string;
  readonly toolSurface?: ToolActivitySurface;
  readonly toolIcon?: ToolActivityIcon;
  readonly toolSource?: ToolActivitySource;
} {
  const source =
    typeof input.source === "object" && input.source !== null ? input.source : undefined;
  const qualified =
    typeof input.toolName === "string" ? /^mcp__(.+?)__(.+)$/i.exec(input.toolName) : null;
  const server = normalizeMcpText(input.serverName ?? qualified?.[1] ?? input.serverDisplayName);
  const tool = normalizeMcpText(qualified?.[2] ?? input.toolName);
  if (server && tool && resolveT3McpToolDefinition(`${server}.${tool}`)) return {};
  // Cua Driver calls read as computer use in every provider, like Codex's own.
  if (server && tool && isCuaServerName(server) && input.threadId) {
    const cua = cuaToolPresentation({
      threadId: input.threadId,
      rawToolName: `mcp__cua-driver__${tool}`,
      args: input.args,
      status: input.status ?? "completed",
    });
    if (cua) return cua;
  }
  const title =
    normalizeMcpText(input.title) ??
    (server && tool ? normalizeMcpText(tool.replace(/[_-]+/gu, " ")) : undefined);
  if (!server) return title ? { title } : {};
  const name =
    normalizeMcpText(input.serverDisplayName) ??
    normalizeMcpText(source && Reflect.get(source, "name")) ??
    normalizeMcpText(server.replace(/[_-]+/gu, " ")) ??
    server;
  const logoUrl =
    normalizeMcpHttpUrl(input.iconUrl) ??
    normalizeMcpHttpUrl(source && Reflect.get(source, "logoUrl"));
  const logoUrlDark =
    normalizeMcpHttpUrl(input.iconUrlDark) ??
    normalizeMcpHttpUrl(source && Reflect.get(source, "logoUrlDark"));
  const icon = logoUrl
    ? { _tag: "themed-logo" as const, logoUrl, ...(logoUrlDark ? { logoUrlDark } : {}) }
    : undefined;
  return {
    ...(title ? { title } : {}),
    ...(icon ? { toolIcon: icon } : {}),
    toolSource: {
      key: `mcp:${server.toLowerCase()}`,
      name,
      kind: "integration",
      ...(icon ? { icon } : {}),
    },
  };
}

/**
 * The Cua Driver context for an MCP item: its thread, input, and status. A
 * completed call also teaches the thread which app each pid is, so later
 * calls can name it.
 */
export function cuaCallContext(input: {
  readonly serverName: string | undefined;
  readonly toolName: string | undefined;
  readonly threadId: ThreadId | null;
  readonly status: string;
  readonly args: unknown;
  readonly result?: unknown;
}): {
  readonly threadId?: ThreadId;
  readonly args?: unknown;
  readonly status?: "inProgress" | "completed" | "failed";
} {
  if (!isCuaServerName(input.serverName) || !input.toolName || input.threadId === null) return {};
  const status =
    input.status === "completed"
      ? ("completed" as const)
      : input.status === "running" || input.status === "pending"
        ? ("inProgress" as const)
        : ("failed" as const);
  if (status === "completed" && input.result !== undefined) {
    rememberCuaToolResult(input.threadId, input.toolName, input.args, input.result);
  }
  return { threadId: input.threadId, args: input.args, status };
}
