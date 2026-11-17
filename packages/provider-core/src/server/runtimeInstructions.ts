/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Next call: use link_pull_request for each PR you create, take over, or push to (link_pull_requests for several). Pass full URLs for every stack layer. Host tools don't link for you.
If available, call link_issue for each issue you take on or file, even via CLI. Prefer its full URL. Skip PRs and issues you only read, review, or mention as background. If linking fails, say so.
Use watch_pull_request when asked to monitor or babysit, or when your task waits on checks or reviews, even after unwatching. Push needed updates first, then watch and end your turn. Otherwise act or hand back. Delegated children never watch. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request for each PR you watch.
</pull_request_linking>`;

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
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
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in T3 Code's files viewer.</runtime_info>`;
  return runtime.pullRequestLinking === false
    ? runtimeInfo
    : `${runtimeInfo}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
