import { latheMcpToolLabel } from "./forkLegacyMcp.ts";

export type LatheMcpToolLogo = "lathe";

export interface LatheMcpToolPresentation {
  readonly displayName: string;
  readonly logo: LatheMcpToolLogo;
}

export type LatheMcpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "workflow-stop"
  | "background-wait"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-links"
  | "environment-link"
  | "environment-unlink"
  | "environment-update"
  | "theme-read"
  | "theme-set"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "write-pr-guides"
  | "read-pr-guide"
  | "list-issues"
  | "read-issue"
  | "create-issue"
  | "comment-issue"
  | "set-issue-state"
  | "link-issue"
  | "unlink-issue"
  | "list-thread-issues"
  | "read-pr"
  | "list-repo-prs"
  | "create-pr"
  | "update-pr"
  | "respond-pr"
  | "merge-pr"
  | "review-pr"
  | "ci-logs"
  | "ci-rerun"
  | "browser"
  | "device"
  | "html-preview"
  | "html-render"
  | "send-to-user"
  // Fork: document comment tools.
  | "comment-list"
  | "comment-resolve"
  // Fork: roadmap.
  | "roadmap-read"
  | "roadmap-create"
  | "roadmap-update"
  | "roadmap-log-hours";

export interface LatheMcpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "lathe" | "browser" | "device" | "pull-request";
  readonly summaryAction: LatheMcpToolSummaryAction;
}

function tool(
  labels: LatheMcpToolDefinition["labels"],
  summaryAction: LatheMcpToolSummaryAction,
  icon: LatheMcpToolDefinition["icon"] = "lathe",
  displayName = `${labels[0]} ${labels[3]}`,
): LatheMcpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

// Codex registers "lathe-direct" for Lathe tools kept out of Code Mode.
const LATHE_MCP_SERVER_ALIASES = new Set([
  "lathe",
  "t3-code",
  "t3_code",
  "t3code",
  "lathe-direct",
  "lathe_direct",
]);

const LATHE_MCP_TOOLS: Readonly<Record<string, LatheMcpToolDefinition>> = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  link_pull_requests: tool(
    ["Link", "Linking", "Linked", "pull requests"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  unlink_pull_requests: tool(
    ["Unlink", "Unlinking", "Unlinked", "pull requests by state"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Unwatching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  write_pull_request_guides: tool(
    ["Write", "Writing", "Started writing", "review guides"],
    "write-pr-guides",
    "pull-request",
  ),
  read_pull_request_guide: tool(
    ["Read", "Reading", "Read", "a review guide"],
    "read-pr-guide",
    "pull-request",
  ),
  list_issues: tool(["List", "Listing", "Listed", "issues"], "list-issues"),
  read_issue: tool(["Read", "Reading", "Read", "an issue"], "read-issue"),
  create_issue: tool(["File", "Filing", "Filed", "an issue"], "create-issue"),
  comment_on_issue: tool(
    ["Comment on", "Commenting on", "Commented on", "an issue"],
    "comment-issue",
  ),
  set_issue_state: tool(["Change", "Changing", "Changed", "an issue's state"], "set-issue-state"),
  link_issue: tool(["Link", "Linking", "Linked", "an issue"], "link-issue"),
  unlink_issue: tool(["Unlink", "Unlinking", "Unlinked", "an issue"], "unlink-issue"),
  list_thread_issues: tool(["Check", "Checking", "Checked", "linked issues"], "list-thread-issues"),
  pull_request_read: tool(["Read", "Reading", "Read", "a pull request"], "read-pr", "pull-request"),
  pull_request_list: tool(
    ["List", "Listing", "Listed", "pull requests"],
    "list-repo-prs",
    "pull-request",
  ),
  pull_request_create: tool(
    ["Open", "Opening", "Opened", "a pull request"],
    "create-pr",
    "pull-request",
  ),
  pull_request_update: tool(
    ["Update", "Updating", "Updated", "a pull request"],
    "update-pr",
    "pull-request",
  ),
  pull_request_respond: tool(
    ["Respond", "Responding", "Responded", "on a pull request"],
    "respond-pr",
    "pull-request",
  ),
  pull_request_review: tool(
    ["Review", "Reviewing", "Reviewed", "a pull request"],
    "review-pr",
    "pull-request",
  ),
  ci_logs: tool(["Read", "Reading", "Read", "CI logs"], "ci-logs", "pull-request"),
  ci_rerun: tool(["Re-run", "Re-running", "Re-ran", "CI"], "ci-rerun", "pull-request"),
  pull_request_merge: tool(
    ["Merge", "Merging", "Merged", "a pull request"],
    "merge-pr",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(["Schedule", "Scheduling", "Scheduled", "a task"], "schedule-create"),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  create_threads: tool(["Create", "Creating", "Created", "Lathe threads"], "thread-create"),
  lathe_thread_start: tool(["Start", "Starting", "Started", "a Lathe thread"], "thread-create"),
  lathe_thread_list: tool(["List", "Listing", "Listed", "Lathe threads"], "thread-list"),
  lathe_thread_read: tool(["Read", "Reading", "Read", "a Lathe thread"], "thread-read"),
  // Fork: thread history and document comments.
  read_thread: tool(["Read", "Reading", "Read", "a thread's history"], "thread-read"),
  read_thread_turns: tool(["Read", "Reading", "Read", "earlier turns of a thread"], "thread-read"),
  find_threads: tool(["Search", "Searching", "Searched", "other threads"], "thread-search"),
  list_document_comments: tool(["List", "Listing", "Listed", "document comments"], "comment-list"),
  resolve_document_comment: tool(
    ["Resolve", "Resolving", "Resolved", "a document comment"],
    "comment-resolve",
  ),
  // Fork: roadmap.
  lathe_roadmap_list: tool(["List", "Listing", "Listed", "roadmap work items"], "roadmap-read"),
  lathe_roadmap_read: tool(["Read", "Reading", "Read", "a roadmap work item"], "roadmap-read"),
  lathe_roadmap_create: tool(
    ["Create", "Creating", "Created", "a roadmap work item"],
    "roadmap-create",
  ),
  lathe_roadmap_update: tool(
    ["Update", "Updating", "Updated", "a roadmap work item"],
    "roadmap-update",
  ),
  lathe_roadmap_criterion_tick: tool(
    ["Tick", "Ticking", "Ticked", "an acceptance criterion"],
    "roadmap-update",
  ),
  lathe_roadmap_attach: tool(
    ["Attach", "Attaching", "Attached", "a thread to a work item"],
    "roadmap-update",
  ),
  lathe_roadmap_detach: tool(
    ["Detach", "Detaching", "Detached", "a thread from a work item"],
    "roadmap-update",
  ),
  lathe_roadmap_link_blocker: tool(
    ["Link", "Linking", "Linked", "a roadmap blocker"],
    "roadmap-update",
  ),
  lathe_roadmap_log_hours: tool(
    ["Log", "Logging", "Logged", "hours on a work item"],
    "roadmap-log-hours",
  ),
  lathe_roadmap_add_note: tool(
    ["Add", "Adding", "Added", "a progress note to a work item"],
    "roadmap-update",
  ),
  lathe_roadmap_import_issue: tool(
    ["Import", "Importing", "Imported", "a GitHub issue to the roadmap"],
    "roadmap-create",
  ),
  lathe_roadmap_link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request to a work item"],
    "roadmap-update",
  ),
  lathe_thread_send: tool(["Send", "Sending", "Sent", "to a Lathe thread"], "thread-send"),
  lathe_thread_wait: tool(["Wait", "Waiting", "Waited", "for a Lathe thread"], "thread-wait"),
  lathe_workflow_stop: tool(
    ["Stop", "Stopping", "Requested a stop for", "a workflow"],
    "workflow-stop",
  ),
  lathe_background_wait: tool(
    ["Update", "Updating", "Updated", "background waits"],
    "background-wait",
  ),
  lathe_thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a Lathe thread"],
    "thread-interrupt",
  ),
  lathe_worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  lathe_worktree_status: tool(
    ["Get", "Getting", "Got", "thread worktree status"],
    "worktree-status",
  ),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_act: tool(["Use", "Using", "Used", "the preview browser"], "browser", "browser"),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  lathe_queue: tool(["Manage", "Managing", "Managed", "queued messages"], "queue-edit"),
  lathe_pending_request: tool(
    ["Handle", "Handling", "Handled", "pending questions"],
    "question-respond",
  ),
  lathe_queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  lathe_queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  lathe_queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  lathe_queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  lathe_queue_reorder: tool(
    ["Reorder", "Reordering", "Reordered", "a queued run"],
    "queue-reorder",
  ),
  lathe_queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  lathe_pending_request_list: tool(
    ["List", "Listing", "Listed", "pending questions"],
    "question-list",
  ),
  lathe_pending_request_read: tool(
    ["Read", "Reading", "Read", "pending questions"],
    "question-read",
  ),
  lathe_pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  lathe_thread_configuration: tool(
    ["Read", "Reading", "Read", "thread configuration"],
    "thread-configuration",
  ),
  lathe_thread_configure: tool(
    ["Use", "Using", "Used", "thread model settings"],
    "thread-configure",
  ),
  lathe_thread_transfer: tool(["Use", "Using", "Used", "thread transfers"], "thread-fork"),
  lathe_thread_fork: tool(["Fork", "Forking", "Requested a fork of", "this thread"], "thread-fork"),
  lathe_thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  lathe_thread_search: tool(["Search", "Searching", "Searched", "thread content"], "thread-search"),
  lathe_thread_transfers: tool(["Read", "Reading", "Read", "thread transfers"], "thread-transfers"),
  lathe_thread_organize: tool(
    ["Organize", "Organizing", "Organized", "a thread"],
    "thread-organize",
  ),
  lathe_thread_update: tool(
    ["Update", "Updating", "Updated", "Lathe thread metadata"],
    "thread-update",
  ),
  lathe_worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  lathe_preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  lathe_preview_close: tool(["Close", "Closing", "Closed", "a preview tab"], "browser", "browser"),
  lathe_environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  lathe_environment_links: tool(
    ["List", "Listing", "Listed", "linked environments"],
    "environment-links",
  ),
  lathe_environment_link: tool(
    ["Ask to link", "Asking to link", "Asked to link", "an environment"],
    "environment-link",
  ),
  lathe_environment_unlink: tool(
    ["Forget", "Forgetting", "Forgot", "a linked environment"],
    "environment-unlink",
  ),
  lathe_environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  lathe_theme_read: tool(["Read", "Reading", "Read", "themes"], "theme-read"),
  lathe_theme_set: tool(["Set", "Setting", "Set", "the theme"], "theme-set"),
  lathe_thread_launch: tool(
    ["Launch", "Launching", "Launched", "a project thread"],
    "thread-create",
  ),
  lathe_project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  lathe_project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  lathe_project_create: tool(
    ["Register", "Registering", "Registered", "a project"],
    "project-create",
  ),
  lathe_project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  lathe_project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  lathe_project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  lathe_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  lathe_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  lathe_thread_send_attachments: tool(
    ["Send", "Sending", "Sent", "attachments"],
    "attachment-send",
  ),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
  send_to_user: tool(["Send", "Sending", "Sent", "a message"], "send-to-user"),
};

export const LATHE_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(LATHE_MCP_TOOLS));

function normalizeLatheMcpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

// Timelines resolve every work row's tool name on each update; names repeat across updates.
// ACP titles can carry whole commands, so long labels are parsed but not kept.
const toolNameCache = new Map<string, string | null>();
const TOOL_NAME_CACHE_LIMIT = 10_000;
const TOOL_NAME_CACHE_MAX_KEY_LENGTH = 256;

function resolveLatheMcpToolName(value: string): string | null {
  if (value.length > TOOL_NAME_CACHE_MAX_KEY_LENGTH) return parseLatheMcpToolName(value);
  const cached = toolNameCache.get(value);
  if (cached !== undefined) return cached;
  const name = parseLatheMcpToolName(value);
  if (toolNameCache.size >= TOOL_NAME_CACHE_LIMIT) toolNameCache.clear();
  toolNameCache.set(value, name);
  return name;
}

// ACP tool prefixes vary; match loosely but require a known display-name entry.
function parseLatheMcpToolName(value: string): string | null {
  const label = latheMcpToolLabel(normalizeLatheMcpToolLabel(value));
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      LATHE_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch =
    /^(?<server>lathe[-_]direct|lathe|t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(
      label,
    );
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  const prefixed = /^(?:mcp[-_]{1,2})?(?:lathe|t3[-_ ]?code)(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(
    label,
  );
  // Fork-only: the server and its own tools share the name lathe, so a bare
  // lathe_* tool would otherwise read as server lathe and tool *.
  const candidate = Object.hasOwn(LATHE_MCP_TOOLS, label)
    ? label
    : (prefixed?.groups?.tool ?? label);
  if (Object.hasOwn(LATHE_MCP_TOOLS, candidate)) return candidate;
  // OpenCode 2 thread prefixes can contain underscores; choose the longest known tool-name suffix.
  if (!/^lathe-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(LATHE_MCP_TOOLS)) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

export function resolveLatheMcpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveLatheMcpToolName(toolName);
  return name !== null && Object.hasOwn(LATHE_MCP_TOOLS, name) ? name : null;
}

type SummaryInput = Readonly<Record<string, unknown>>;

const asSummaryInput = (input: unknown): SummaryInput | undefined =>
  typeof input === "object" && input !== null ? (input as SummaryInput) : undefined;

/** Action tools present each call as the single-purpose tool its action replaced. */
const ACTION_TOOLS: Readonly<Record<string, (action: string) => string | undefined>> = {
  preview_act: (action) => `preview_${action}`,
  lathe_queue: (action) => `lathe_queue_${action}`,
  lathe_pending_request: (action) => `lathe_pending_request_${action}`,
  lathe_thread_transfer: (action) =>
    ({
      fork: "lathe_thread_fork",
      merge_back: "lathe_thread_merge_back",
      status: "lathe_thread_transfers",
    })[action],
};

/** Pass the call's input so an action tool resolves to the labels and summary of its action. */
export function resolveLatheMcpToolDefinition(
  toolName: string | null | undefined,
  input?: unknown,
): LatheMcpToolDefinition | null {
  const name = toolName == null ? null : resolveLatheMcpToolName(toolName);
  if (name === null || !Object.hasOwn(LATHE_MCP_TOOLS, name)) return null;
  const action = asSummaryInput(input)?.action;
  const actionTool = typeof action === "string" ? ACTION_TOOLS[name]?.(action) : undefined;
  return actionTool !== undefined && Object.hasOwn(LATHE_MCP_TOOLS, actionTool)
    ? LATHE_MCP_TOOLS[actionTool]!
    : LATHE_MCP_TOOLS[name]!;
}

/** Tools whose summary depends on which fields a call sets. */
const ACTION_SUMMARIES: Readonly<
  Record<string, (input: SummaryInput) => LatheMcpToolSummaryAction | undefined>
> = {
  lathe_thread_configure: ({ modelSelection }) =>
    modelSelection === undefined ? "thread-configuration" : "thread-configure",
  schedule_task: ({ scheduledTaskId }) =>
    scheduledTaskId === undefined ? "schedule-create" : "schedule-update",
};

export function resolveLatheMcpSummaryAction(
  toolName: string | null | undefined,
  input: unknown,
): LatheMcpToolSummaryAction | null {
  const definition = resolveLatheMcpToolDefinition(toolName, input);
  if (definition === null) return null;
  const summarize = ACTION_SUMMARIES[resolveLatheMcpToolName(toolName!) ?? ""];
  const fields = asSummaryInput(input);
  return (fields && summarize?.(fields)) ?? definition.summaryAction;
}

export function resolveLatheMcpToolPresentation(
  toolName: string | null | undefined,
  input?: unknown,
): LatheMcpToolPresentation | null {
  const definition = resolveLatheMcpToolDefinition(toolName, input);
  return definition === null ? null : { displayName: definition.displayName, logo: "lathe" };
}
