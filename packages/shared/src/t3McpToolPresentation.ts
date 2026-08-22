export type T3McpToolLogo = "t3-code";

export interface T3McpToolPresentation {
  readonly displayName: string;
  readonly logo: T3McpToolLogo;
}

export interface ResolveT3McpToolPresentationOptions {
  /**
   * Projected tool input. OpenCode 2 bridges MCP through `execute` with a
   * `code` string that calls `tools["t3-code"].toolName(...)`.
   */
  readonly input?: unknown;
}

const T3_MCP_SERVER_ALIASES = new Set(["t3-code", "t3_code", "t3code"]);

const T3_MCP_TOOL_DISPLAY_NAMES: Record<string, string> = {
  orchestrator_capabilities: "Get orchestration capabilities",
  delegate_task: "Delegate a child task",
  task_status: "Get delegated task status",
  task_cancel: "Cancel delegated task",
  schedule_task: "Schedule a recurring task",
  list_scheduled_tasks: "List scheduled tasks",
  update_scheduled_task: "Update a scheduled task",
  delete_scheduled_task: "Delete a scheduled task",
  create_threads: "Create T3 threads",
  t3_thread_start: "Start a T3 thread",
  t3_thread_list: "List T3 threads",
  t3_thread_read: "Read a T3 thread",
  t3_thread_send: "Send to a T3 thread",
  t3_thread_wait: "Wait for a T3 thread",
  t3_thread_interrupt: "Interrupt a T3 thread",
  t3_worktree_handoff: "Hand off thread to a git worktree",
  t3_worktree_status: "Get thread worktree status",
  preview_status: "Get preview browser status",
  preview_open: "Open a page in the preview browser",
  preview_navigate: "Navigate the preview browser",
  preview_snapshot: "Snapshot the preview page",
  preview_click: "Click in the preview browser",
  preview_press: "Press a key in the preview browser",
  preview_type: "Type in the preview browser",
  preview_scroll: "Scroll the preview browser",
  preview_resize: "Resize the preview browser",
  preview_evaluate: "Evaluate script in the preview browser",
  preview_wait_for: "Wait for the preview page",
  preview_set_appearance: "Set preview browser appearance",
  preview_recording_start: "Start recording the preview browser",
  preview_recording_stop: "Stop recording the preview browser",
};

function normalizeT3McpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/**
 * OpenCode 2's built-in `execute` tool runs JS that calls MCP as
 * `tools["t3-code"].tool_name(...)`. Pull the first t3-code tool so the
 * timeline can show the T3 logo and pretty name instead of bare "execute".
 *
 * @internal exported for tests
 */
export function extractOpenCode2ExecuteT3McpToolName(code: string): string | null {
  const dot = /tools\s*\[\s*["']t3-code["']\s*\]\s*\.\s*([A-Za-z0-9_]+)\s*\(/.exec(code);
  const bracket = /tools\s*\[\s*["']t3-code["']\s*\]\s*\[\s*["']([A-Za-z0-9_]+)["']\s*\]\s*\(/.exec(
    code,
  );
  const candidates = [
    dot?.[1] === undefined || dot.index === undefined ? null : { index: dot.index, name: dot[1] },
    bracket?.[1] === undefined || bracket.index === undefined
      ? null
      : { index: bracket.index, name: bracket[1] },
  ].filter((candidate): candidate is { index: number; name: string } => candidate !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, candidate) =>
    candidate.index < earliest.index ? candidate : earliest,
  ).name;
}

function codeFromToolInput(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const code = (input as { readonly code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function resolveT3McpToolName(value: string): string | null {
  const label = normalizeT3McpToolLabel(value);
  // Claude / Cursor-style MCP wire names: mcp__t3-code__tool_name
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      T3_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  // Provider-native server namespaces:
  // - Codex-style: t3-code.tool_name (also :, /)
  // - Grok ACP-style: t3-code__tool_name (double underscore, no mcp__ prefix)
  const namespaceMatch = /^(?<server>t3-code|t3_code|t3code)(?:[.:/]|__)(?<tool>.+)$/i.exec(label);
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  return Object.hasOwn(T3_MCP_TOOL_DISPLAY_NAMES, label) ? label : null;
}

function presentationForToolName(resolvedToolName: string): T3McpToolPresentation | null {
  const displayName = T3_MCP_TOOL_DISPLAY_NAMES[resolvedToolName];
  if (displayName === undefined) {
    return null;
  }
  return {
    displayName,
    logo: "t3-code",
  };
}

export function resolveT3McpToolPresentation(
  toolName: string | null | undefined,
  options?: ResolveT3McpToolPresentationOptions,
): T3McpToolPresentation | null {
  const resolvedToolName =
    toolName === undefined || toolName === null ? null : resolveT3McpToolName(toolName);
  if (resolvedToolName !== null) {
    return presentationForToolName(resolvedToolName);
  }

  // OpenCode 2 execute bridge: toolName is "execute", real MCP call is in code.
  const label =
    toolName === undefined || toolName === null ? "" : normalizeT3McpToolLabel(toolName);
  if (label.toLowerCase() !== "execute") {
    return null;
  }
  const code = codeFromToolInput(options?.input);
  if (code === null) {
    return null;
  }
  const embedded = extractOpenCode2ExecuteT3McpToolName(code);
  return embedded === null ? null : presentationForToolName(embedded);
}
