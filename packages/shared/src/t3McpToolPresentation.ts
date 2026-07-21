export type T3McpToolLogo = "t3-code";

export interface T3McpToolPresentation {
  readonly displayName: string;
  readonly logo: T3McpToolLogo;
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
};

function normalizeT3McpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function resolveT3McpToolName(value: string): string | null {
  const label = normalizeT3McpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined && tool !== undefined && T3_MCP_SERVER_ALIASES.has(server)
      ? tool
      : null;
  }

  const namespaceMatch = /^(?<server>t3-code|t3_code|t3code)[.:/](?<tool>.+)$/.exec(label);
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  return Object.hasOwn(T3_MCP_TOOL_DISPLAY_NAMES, label) ? label : null;
}

export function resolveT3McpToolPresentation(
  toolName: string | null | undefined,
): T3McpToolPresentation | null {
  const resolvedToolName =
    toolName === undefined || toolName === null ? null : resolveT3McpToolName(toolName);
  if (resolvedToolName === null) {
    return null;
  }
  const displayName = T3_MCP_TOOL_DISPLAY_NAMES[resolvedToolName];
  if (displayName === undefined) {
    return null;
  }
  return {
    displayName,
    logo: "t3-code",
  };
}
