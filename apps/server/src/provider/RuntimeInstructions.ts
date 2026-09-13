const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

const MESSAGE_ARTIFACT_INSTRUCTIONS = `<message_artifacts>
When you want to show an interactive HTML page in your reply, write a self-contained HTML file (inline scripts, styles and data; no network access; at most 1 MB) in the workspace and add a fenced code block with the language t3-artifact whose only content is the file's workspace-relative path. Size the page by its content, not the window height. The page can use the MCP Apps theme CSS variables such as var(--color-background-primary) and var(--color-text-primary). Form values are restored automatically; to keep other state, call window.t3.setState(value) with JSON and read window.t3.state on load.
</message_artifacts>`;

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** The resolved `enableMessageArtifacts` setting; the server only captures artifacts when it is on. */
  readonly messageArtifacts?: boolean | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const artifacts = runtime.messageArtifacts ? `\n\n${MESSAGE_ARTIFACT_INSTRUCTIONS}` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${artifacts}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
