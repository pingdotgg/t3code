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

function resolveT3McpToolName(value: string): string | null {
  const label = normalizeT3McpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      T3_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch = /^(?<server>t3-code|t3_code|t3code)[.:/](?<tool>.+)$/i.exec(label);
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
