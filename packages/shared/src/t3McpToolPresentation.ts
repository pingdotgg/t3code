export type T3McpToolLogo = "t3-code";

export interface T3McpToolPresentation {
  readonly displayName: string;
  readonly logo: T3McpToolLogo;
}

export type T3McpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt";

const T3_MCP_SERVER_ALIASES = new Set(["t3-code", "t3_code", "t3code"]);

const T3_MCP_TOOLS: Record<
  string,
  { readonly displayName: string; readonly summaryAction?: T3McpToolSummaryAction }
> = {
  orchestrator_capabilities: {
    displayName: "Get orchestration capabilities",
    summaryAction: "capabilities",
  },
  delegate_task: { displayName: "Delegate a child task", summaryAction: "delegate" },
  task_status: { displayName: "Get delegated task status", summaryAction: "task-status" },
  task_cancel: { displayName: "Cancel delegated task", summaryAction: "task-cancel" },
  schedule_task: { displayName: "Schedule a recurring task", summaryAction: "schedule-create" },
  list_scheduled_tasks: { displayName: "List scheduled tasks", summaryAction: "schedule-list" },
  update_scheduled_task: {
    displayName: "Update a scheduled task",
    summaryAction: "schedule-update",
  },
  delete_scheduled_task: {
    displayName: "Delete a scheduled task",
    summaryAction: "schedule-delete",
  },
  create_threads: { displayName: "Create T3 threads", summaryAction: "thread-create" },
  t3_thread_start: { displayName: "Start a T3 thread", summaryAction: "thread-create" },
  t3_thread_list: { displayName: "List T3 threads", summaryAction: "thread-list" },
  t3_thread_read: { displayName: "Read a T3 thread", summaryAction: "thread-read" },
  t3_thread_send: { displayName: "Send to a T3 thread", summaryAction: "thread-send" },
  t3_thread_wait: { displayName: "Wait for a T3 thread", summaryAction: "thread-wait" },
  t3_thread_interrupt: { displayName: "Interrupt a T3 thread", summaryAction: "thread-interrupt" },
  t3_worktree_handoff: { displayName: "Hand off thread to a git worktree" },
  t3_worktree_status: { displayName: "Get thread worktree status" },
  preview_status: { displayName: "Get preview browser status" },
  preview_open: { displayName: "Open a page in the preview browser" },
  preview_navigate: { displayName: "Navigate the preview browser" },
  preview_snapshot: { displayName: "Snapshot the preview page" },
  preview_click: { displayName: "Click in the preview browser" },
  preview_press: { displayName: "Press a key in the preview browser" },
  preview_type: { displayName: "Type in the preview browser" },
  preview_scroll: { displayName: "Scroll the preview browser" },
  preview_resize: { displayName: "Resize the preview browser" },
  preview_evaluate: { displayName: "Evaluate script in the preview browser" },
  preview_wait_for: { displayName: "Wait for the preview page" },
  preview_set_appearance: { displayName: "Set preview browser appearance" },
  preview_recording_start: { displayName: "Start recording the preview browser" },
  preview_recording_stop: { displayName: "Stop recording the preview browser" },
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

  return Object.hasOwn(T3_MCP_TOOLS, label) ? label : null;
}

export function resolveT3McpToolPresentation(
  toolName: string | null | undefined,
): T3McpToolPresentation | null {
  const resolvedToolName =
    toolName === undefined || toolName === null ? null : resolveT3McpToolName(toolName);
  if (resolvedToolName === null) {
    return null;
  }
  const displayName = T3_MCP_TOOLS[resolvedToolName]?.displayName;
  if (displayName === undefined) {
    return null;
  }
  return {
    displayName,
    logo: "t3-code",
  };
}

export function resolveT3McpToolSummaryAction(
  toolName: string | null | undefined,
): T3McpToolSummaryAction | null {
  const name = toolName == null ? null : resolveT3McpToolName(toolName);
  return name === null ? null : (T3_MCP_TOOLS[name]?.summaryAction ?? null);
}
