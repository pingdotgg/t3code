import type { AgentFeedbackMode } from "@lathe/contracts";

import type { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";

/** None while agent feedback is off, so users who never opt in pay no context for it. */
export const AGENT_FEEDBACK_INSTRUCTIONS = {
  off: "",
  "on-request": "Use `lathe_feedback` only when the user asks you to send Lathe feedback.",
  auto: "`lathe_feedback` reports are wanted and cheap. Send one, then continue, when a Lathe tool or `lathe` command fails or gives a wrong result, the user corrects how you use Lathe, or a Lathe capability you looked for is missing. Once per problem; also when the user asks. Only about Lathe, never the user's code or other tools.",
} satisfies Record<AgentFeedbackMode, string>;

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
  readonly agentFeedback?: AgentFeedbackMode;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly threadHistory?: ThreadHistoryInstructionMode | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
  /** Adds the folder list of a multi-folder thread. */
  readonly runtimePolicy?: Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace"> | undefined;
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
  const feedbackLine = AGENT_FEEDBACK_INSTRUCTIONS[runtime.agentFeedback ?? "off"];
  const feedback = feedbackLine ? `\n${feedbackLine}` : "";
  const workspace =
    runtime.runtimePolicy === undefined ? "" : buildWorkspaceInstructions(runtime.runtimePolicy);
  // Fork: Lathe's blocks follow upstream's text. Upstream's recorded prompts begin with that
  // text, and replay matches them against what is built here.
  const core = `${runtimeInfo}${pullRequestLinking}${feedback}\n\n${DOCUMENT_COMMENT_INSTRUCTIONS}${threadHistory}`;
  return [core, ...(workspace === "" ? [] : [workspace])].join("\n\n");
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

// Codex truncates context entries over 4,000 bytes, and this block is sent as its own entry.
const WORKSPACE_INSTRUCTIONS_MAX_BYTES = 3_600;
const FOLDER_NAME_MAX_LENGTH = 64;
// Control characters and Unicode line separators would let a name or path add lines.
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const textEncoder = new TextEncoder();

const byteLength = (value: string) => textEncoder.encode(value).length;

/** Names come from users and disk; keep each one a short label that cannot close the block. */
function folderLabel(name: string): string {
  const label = Array.from(
    name.replaceAll(LINE_BREAKING, " ").replaceAll(/[<>`]/g, " ").replaceAll(/\s+/g, " ").trim(),
  );
  if (label.length === 0) return "folder";
  return label.length > FOLDER_NAME_MAX_LENGTH
    ? `${label.slice(0, FOLDER_NAME_MAX_LENGTH - 1).join("")}…`
    : label.join("");
}

const folderPath = (value: string) =>
  value.replaceAll(LINE_BREAKING, "?").replaceAll("<", "‹").replaceAll(">", "›");

/** Lists a multi-folder thread's folders. Empty for single-folder threads, so their text is unchanged. */
export function buildWorkspaceInstructions(
  runtimePolicy: Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace">,
): string {
  const workspace = runtimePolicy.workspace;
  if (workspace === undefined || workspace.folders.length === 0) return "";
  const head = [
    "<workspace_folders>",
    "This project spans several folders. Each Git repository has its own history and branches: run Git commands inside the repository you change, and commit each one separately.",
    ...(runtimePolicy.cwd === null
      ? []
      : [`- Your working directory: ${folderPath(runtimePolicy.cwd)}`]),
  ];
  const tail = ["</workspace_folders>"];
  const entries = workspace.folders.map(
    (folder) =>
      `- ${folderLabel(folder.name)} (${folder.isGitRepository ? "Git repository" : "folder"}): ${folderPath(folder.path)}`,
  );
  // Reserve room for the line that counts folders left out.
  let budget = WORKSPACE_INSTRUCTIONS_MAX_BYTES - byteLength([...head, ...tail].join("\n")) - 32;
  const shown: Array<string> = [];
  for (const entry of entries) {
    budget -= byteLength(entry) + 1;
    if (budget < 0) break;
    shown.push(entry);
  }
  const hidden = entries.length - shown.length;
  return [...head, ...shown, ...(hidden > 0 ? [`- Not listed: ${hidden} more`] : []), ...tail].join(
    "\n",
  );
}
