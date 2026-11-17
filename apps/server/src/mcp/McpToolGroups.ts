import { T3_CALL_TOOL_NAME } from "@t3tools/shared/t3McpToolPresentation";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export const T3_HELP = "t3_help";

interface ToolGroup {
  readonly name: string;
  readonly description: string;
  readonly tools: ReadonlyArray<string>;
}

/**
 * Every advertised tool belongs to one group. A client that cannot defer tools
 * sees these names and descriptions first, then loads one group with `t3_help`.
 */
export const TOOL_GROUPS: ReadonlyArray<ToolGroup> = [
  {
    name: "delegation",
    description: "Delegate work to subagents, check or cancel it, and wait on background work.",
    tools: [
      "orchestrator_capabilities",
      "delegate_task",
      "task_status",
      "task_cancel",
      "t3_workflow_stop",
      "t3_background_wait",
    ],
  },
  {
    name: "threads",
    description: "Start, list, read, search, message, wait on, configure, and organize threads.",
    tools: [
      "create_threads",
      "t3_thread_launch",
      "t3_thread_list",
      "t3_thread_read",
      "t3_thread_search",
      "t3_thread_send",
      "t3_thread_wait",
      "t3_thread_interrupt",
      "t3_thread_configure",
      "t3_thread_transfer",
      "t3_thread_organize",
      "t3_thread_update",
      "t3_queue",
      "t3_pending_request",
    ],
  },
  {
    name: "user",
    description: "Ask the user for a secret, or send them a message before the turn ends.",
    tools: ["request_secret", "send_to_user"],
  },
  {
    name: "pull_requests",
    description: "Link pull requests to a thread, watch them, and write review guides.",
    tools: [
      "link_pull_request",
      "link_pull_requests",
      "unlink_pull_request",
      "unlink_pull_requests",
      "list_thread_pull_requests",
      "watch_pull_request",
      "unwatch_pull_request",
      "write_pull_request_guides",
      "read_pull_request_guide",
    ],
  },
  {
    name: "browser",
    description: "Drive the Browser panel: open, navigate, act, snapshot, and record pages.",
    tools: [
      "preview_status",
      "preview_open",
      "preview_navigate",
      "preview_act",
      "preview_snapshot",
      "preview_evaluate",
      "preview_wait_for",
      "preview_dialog",
      "preview_resize",
      "preview_set_appearance",
      "preview_recording_start",
      "preview_recording_stop",
      "t3_preview_list",
      "t3_preview_close",
    ],
  },
  {
    name: "devices",
    description: "Open and capture iOS Simulators and Android Emulators in the Device panel.",
    tools: ["device_list", "device_open", "device_screenshot", "device_close"],
  },
  {
    name: "visuals",
    description: "Show the user an HTML page or chart in the thread.",
    tools: ["html_preview", "html_render"],
  },
  {
    name: "attachments",
    description: "Send files to a thread.",
    tools: ["t3_attachment_prepare_upload", "t3_attachment_discard", "t3_thread_send_attachments"],
  },
  {
    name: "scheduling",
    description: "Create, list, run, and delete scheduled tasks.",
    tools: [
      "schedule_task",
      "list_scheduled_tasks",
      "run_scheduled_task_now",
      "delete_scheduled_task",
    ],
  },
  {
    name: "projects",
    description: "List, read, register, clone, update, and delete projects.",
    tools: [
      "t3_project_list",
      "t3_project_read",
      "t3_project_create",
      "t3_project_clone",
      "t3_project_update",
      "t3_project_delete",
    ],
  },
  {
    name: "worktrees",
    description: "List worktrees, read their status, and hand a thread to another checkout.",
    tools: ["t3_worktree_list", "t3_worktree_status", "t3_worktree_handoff"],
  },
  {
    name: "environment",
    description: "Read and change this machine's T3 preferences, and link other machines.",
    tools: [
      "t3_environment_read",
      "t3_environment_preferences_update",
      "t3_environment_links",
      "t3_environment_link",
      "t3_environment_unlink",
    ],
  },
  {
    name: "theme",
    description: "Read and restyle T3 Code's own theme.",
    tools: ["t3_theme_read", "t3_theme_set"],
  },
];

export const TOOL_GROUP_NAMES = TOOL_GROUPS.map((group) => group.name).join(", ");

export const TOOL_GROUP_INDEX = TOOL_GROUPS.map(
  (group) => `${group.name}: ${group.description}`,
).join("\n");

/** What a deferring client lists. Pi's extension declares the same first three. */
const DIRECT_TOOLS: ReadonlySet<string> = new Set([
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  T3_HELP,
  T3_CALL_TOOL_NAME,
]);

/** The list never changes within a session, so the client's prompt cache holds. */
export const isListedWhenDeferred = (tool: string) => DIRECT_TOOLS.has(tool);

export const isGatewayTool = (tool: string) => tool === T3_HELP || tool === T3_CALL_TOOL_NAME;

export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export class McpToolCatalog extends Context.Service<
  McpToolCatalog,
  {
    /** Those of the named tools that `tools/list` would show the calling client. */
    readonly listed: (names: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<ListedTool>>;
  }
>()("t3/mcp/McpToolGroups/McpToolCatalog") {}
