import type { ThreadProfile } from "@t3tools/provider-core/server/mcpSession";

/** Drivers whose sessions attach plugins themselves; the rest reach them through `plugin_call`. */
const PLUGIN_NATIVE_DRIVERS: ReadonlySet<string> = new Set([
  "acpRegistry",
  "antigravity",
  "claudeAgent",
  "codex",
  "cursor",
  "fx",
  "grok",
  "kiro",
]);

export const attachesPlugins = (driver: string) => PLUGIN_NATIVE_DRIVERS.has(driver);

const PLUGIN_TOOLS = ["plugin_tools", "plugin_call"];
const CONVERSATION_TOOLS = [
  "quiz",
  "chart",
  "diagram",
  "map",
  "math",
  "timeline",
  "table",
  "choices",
  "flashcards_create_deck",
  "flashcards_add",
  "flashcards_list_decks",
  "flashcards_due",
  "study_stats",
  "memory",
  "session_search",
  "html_preview",
  "html_render",
  "send_to_user",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "run_scheduled_task_now",
  "t3_attachment_prepare_upload",
  "t3_attachment_discard",
  "t3_thread_send_attachments",
  "tool_search",
];
/** The user talks to these threads about the app itself; workers run unattended. */
const APP_TOOLS = ["t3_theme_read", "t3_theme_set"];
/** For models that would need a shell to read a file. */
const FILE_TOOLS = ["file_read"];
const PROJECT_TOOLS = ["project_library_list", "project_library_add"];
const COORDINATOR_TOOLS = [
  "choices",
  "memory",
  "session_search",
  "flashcards_list_decks",
  "study_stats",
  "suggest_threads",
  "ask_decision",
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_send",
  "t3_thread_interrupt",
  "t3_pending_request",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "tool_search",
];

const ALLOWED: Record<Exclude<ThreadProfile, "developer">, ReadonlySet<string>> = {
  chat: new Set([...CONVERSATION_TOOLS, ...FILE_TOOLS, ...APP_TOOLS]),
  worker: new Set([...CONVERSATION_TOOLS, ...FILE_TOOLS, ...PROJECT_TOOLS]),
  coordinator: new Set([...COORDINATOR_TOOLS, ...PROJECT_TOOLS, ...APP_TOOLS]),
};
/** Everything only profiled threads use; a coding thread keeps exactly upstream's tools. */
const KOMPAS_ONLY = new Set([
  ...CONVERSATION_TOOLS.slice(0, 15),
  ...FILE_TOOLS,
  ...PROJECT_TOOLS,
  "suggest_threads",
  "ask_decision",
]);

/** Whether a thread's agent sees and may call a T3 tool. */
export const profileAllowsTool = (
  profile: ThreadProfile,
  tool: string,
  pluginsAttached: boolean,
): boolean => {
  if (PLUGIN_TOOLS.includes(tool)) return !pluginsAttached;
  if (profile === "developer") return !KOMPAS_ONLY.has(tool);
  return ALLOWED[profile].has(tool);
};
