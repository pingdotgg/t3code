const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

/**
 * Only attached when the session actually has the `cua-driver` MCP server.
 * The user shares the screen with the agent, so foreground delivery steals
 * focus and windows the agent leaves open hide the thread they are watching.
 */
const COMPUTER_USE_INSTRUCTIONS = `<computer_use>
The cua-driver MCP tools control the computer the user is working on right now. Every input tool (click, type_text, press_key, hotkey, scroll, drag, ...) defaults to delivery_mode "background", which acts on the target window without raising it or taking focus. Keep that default. Pass delivery_mode "foreground" only after a background action reported that it did not land, and never call bring_to_front just to look at a window: get_window_state captures it without activating it. Target windows by pid and window id rather than by what is frontmost. When the task is done, leave the desktop as you found it: close windows you opened, do not close windows the user had open, and restore the window that was active before you started so the user can see your reply.
</computer_use>`;

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** True when this session's tool list includes the managed `cua-driver` MCP server. */
  readonly computerUse?: boolean | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const computerUse = runtime.computerUse ? `\n\n${COMPUTER_USE_INSTRUCTIONS}` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${computerUse}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
