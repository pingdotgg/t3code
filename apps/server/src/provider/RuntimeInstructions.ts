const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

const HTML_VISUALIZATION_INSTRUCTIONS = `<html_visualizations>
For a useful inline visualization, emit a complete top-level Markdown code fence with language t3-html and optional title="...". T3 Code web and desktop render these fences directly in the timeline after the assistant message finishes; mobile displays their source. Use self-contained HTML, inline CSS, and inline SVG. Native details/summary and CSS checkbox/radio toggles work. Scripts, event handlers, forms, navigation, external resources (including images and fonts), and access to the app are blocked. The visualization inherits the chat typography and live theme, and grows with its content. Use transparent backgrounds, currentColor, and the provided CSS variables: --foreground, --muted-foreground, --background, --card, --primary, --secondary, --accent, --border, --success, --warning, --destructive, --info, and --radius. Use these theme colors for graph strokes, fills, and labels instead of hardcoded palettes. Render the chart or diagram itself, without an outer card, page shell, duplicate title, or toolbar. Use responsive flow layout and width:100%; avoid fixed widths, viewport heights, nested scroll areas, and animations. Keep each visualization under 100,000 characters. Include a short plain-text explanation outside the fence so all clients can read the result. Ordinary html fences remain source code.
</html_visualizations>`;

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${HTML_VISUALIZATION_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
