const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. New watches default to mode "checks": stop and send a final result when all reported checks finish, even failed or cancelled ones; empty results keep waiting. Use mode "review" for ongoing checks and review monitoring after CI finishes. Omitting mode on an existing watch keeps its mode. Finished checks are not approval to merge. After pushing a fix, start a new checks watch if needed. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is the \`report\` line from pull_request_status. Links persist across pushes; active watches do too. Never wait with sleep, loops, gh --watch, Monitor, or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

/**
 * Exported on its own because Claude's native subagents never see the system prompt and get it
 * through a SubagentStart hook.
 */
export const GITHUB_READS_INSTRUCTIONS = `<github_reads>
Read pull requests through T3. pull_request_status returns head, checks, reviews and mergeability. pull_request_failures explains why CI failed. pull_request_feedback returns review threads and bot findings. They share one cached read with the UI, your parent and other agents. gh spends the same GitHub rate limit, so use it for writes, for data these tools don't return, and for repositories T3 can't read. Read diffs with local git. If a T3 read says GitHub is rate limited, stop all GitHub reads, gh included, until the time it names.
</github_reads>`;

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link any other file you produce using its absolute path so the user can open it in T3 Code's files viewer.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${GITHUB_READS_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
