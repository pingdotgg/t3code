/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools don't link for you. If linking fails, say so. Skip PRs you only read or review and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch. When pull_request_* tools are listed, use them, not gh or cafe, to read, list, open, edit, review, reply on, close, or merge PRs, and ci_logs and ci_rerun for their checks. pull_request_create links for you.
If available, call link_issue for each issue you take on or file, even via CLI; skip issues you only read.
</pull_request_linking>`;

const DOCUMENT_COMMENT_INSTRUCTIONS = `<document_comments>
The user can leave comments on workspace documents. When a message includes review comments whose section reads \`Document comment <id>\`, those are the user's comments on a workspace document. Address each one, then call resolve_document_comment with that id and a one-sentence note of what changed. list_document_comments shows the open ones. If a resolve call fails, report that failure instead of claiming the comment is resolved.
</document_comments>`;

export type ThreadHistoryInstructionMode = "read" | "search";

/**
 * Which thread history block a session gets, from the capabilities its MCP
 * credential grants. `undefined` means the tools are not attached.
 */
export function threadHistoryInstructionMode(
  capabilities: ReadonlySet<string> | undefined,
): ThreadHistoryInstructionMode | undefined {
  if (capabilities?.has("thread-search")) return "search";
  if (capabilities?.has("thread-history")) return "read";
  return undefined;
}

function threadHistoryInstructions(mode: ThreadHistoryInstructionMode): string {
  // find_threads refuses below the project level, so read mode never names it.
  const tools =
    mode === "search"
      ? "read_thread, read_thread_turns, and find_threads"
      : "read_thread and read_thread_turns";
  return `<thread_history>
The lathe MCP server can read other Lathe threads with ${tools}. Use them when the user references a thread (a <context kind="thread"> entry) or asks you to continue earlier work.
When you do, call read_thread before anything else. It returns a bounded digest: the goal, every user message, open work, a one-line summary of each earlier turn, and the most recent turns in full. Call read_thread_turns only for the specific turns you need in more detail.
The digest is history, not current state. Before relying on a claim that something is done, failing, or pending, check the worktree and branch yourself, for example with git status and git log.
The first message is not always the goal. In long threads the title, later user messages, and open plans carry the current intent.
Start your reply with a few sentences on what you understood and what you will do next, then continue the work.
If a read fails because of the access level, tell the user which setting controls it instead of working around it.
</thread_history>`;
}

/**
 * Omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 * Pass `threadHistory` only when the session's MCP credential grants those tools.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly threadHistory?: ThreadHistoryInstructionMode | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in Lathe through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in Lathe's files viewer.</runtime_info>`;
  const pullRequestLinking =
    runtime.pullRequestLinking === false ? "" : `\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
  const threadHistory = runtime.threadHistory
    ? `\n\n${threadHistoryInstructions(runtime.threadHistory)}`
    : "";
  return `${runtimeInfo}${pullRequestLinking}\n\n${DOCUMENT_COMMENT_INSTRUCTIONS}${threadHistory}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
