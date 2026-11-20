/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to next: link_pull_request (batch: link_pull_requests), full URLs, every stack layer. pull_request_create auto-links; host commands do not. If linking fails, say so. Skip PRs you only read or review, or know as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Push needed updates first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is the \`report\` line from pull_request_status. Links persist across pushes; active watches do too. Never wait with sleep, loops, gh --watch, Monitor, or ScheduleWakeup. Before handback, call unwatch_pull_request.
If available, call link_issue for each issue you take on or file, even via CLI; skip issues you only read.
</pull_request_linking>`;

/**
 * Exported on its own because Claude's native subagents never see the system prompt and get it
 * through a SubagentStart hook.
 */
export const GITHUB_READS_INSTRUCTIONS = `<github_reads>
Read pull requests through T3. pull_request_status returns head, checks, reviews and mergeability. pull_request_failures explains CI failures; pull_request_feedback shows review threads and bots. Reads share the UI and agent cache. Use T3 tools for PR writes when available. gh spends the same GitHub rate limit; use only for missing operations/data or repos T3 cannot read. Read diffs with local git. If T3 reports a GitHub rate limit, stop all GitHub reads, gh included, until the time it names.
</github_reads>`;

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
  const runtimeInfo = `<runtime_info>If asked: you're running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. Embed media (images/video/audio) as Markdown images with absolute paths. Link every other file you cite or produce by absolute path, e.g. [http.ts:42](/abs/path/http.ts:42), for T3 Code's files viewer.</runtime_info>`;
  return runtime.pullRequestLinking === false
    ? `${runtimeInfo}\n\n${GITHUB_READS_INSTRUCTIONS}`
    : `${runtimeInfo}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${GITHUB_READS_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
