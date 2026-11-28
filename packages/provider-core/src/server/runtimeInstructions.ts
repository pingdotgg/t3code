import type { AgentFeedbackMode } from "@t3tools/contracts";

import type { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";

/** None while agent feedback is off, so users who never opt in pay no context for it. */
export const AGENT_FEEDBACK_INSTRUCTIONS = {
  off: "",
  "on-request": "Use `t3_feedback` only when the user asks you to send T3 feedback.",
  auto: "`t3_feedback` reports are wanted and cheap. Send one, then continue, when a T3 tool or `t3` command fails or gives a wrong result, the user corrects how you use T3 Code, or a T3 capability you looked for is missing. Once per problem; also when the user asks. Only about T3 Code, never the user's code or other tools.",
} satisfies Record<AgentFeedbackMode, string>;

/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Use \`pull_request_*\`/\`ci_logs\`/\`ci_rerun\` over \`gh\`/\`cafe\` when listed (\`pull_request_create\` auto-links). Link created/pushed/taken-over PRs (\`link_pull_request\`/\`link_pull_requests\`, full URL, every stack layer; report failures); skip read/review/background PRs. For PR waits/monitoring (even after an earlier unwatch): push first, call \`watch_pull_request\`, end turn (no sleep/loops/\`gh --watch\`/Monitor/ScheduleWakeup; \`unwatch_pull_request\` before handback). Children never watch (even if the brief says babysit); end PR replies with \`PR <full URL>, head <SHA>, checks and reviews <state>\`. Link worked/filed issues (\`link_issue\`); skip read-only.
</pull_request_linking>`;

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly agentFeedback?: AgentFeedbackMode;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
  /** Adds the folder list of a multi-folder thread and gates git-only linking guidance. */
  readonly runtimePolicy?:
    | Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace" | "isGitRepository">
    | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>If asked: T3 Code via ${harness}${modelInfo}${effortInfo}. Embed images/video/audio with Markdown image syntax and absolute paths. Link every other cited/created file by absolute path, e.g. [http.ts:42](/abs/path/http.ts:42).</runtime_info>`;
  const feedbackLine = AGENT_FEEDBACK_INSTRUCTIONS[runtime.agentFeedback ?? "off"];
  const feedback = feedbackLine ? `\n${feedbackLine}` : "";
  const workspace =
    runtime.runtimePolicy === undefined ? "" : buildWorkspaceInstructions(runtime.runtimePolicy);
  const includePullRequestLinking =
    runtime.pullRequestLinking !== false && runtime.runtimePolicy?.isGitRepository !== false;
  const linked = includePullRequestLinking
    ? `${runtimeInfo}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`
    : runtimeInfo;
  return [linked + feedback, ...(workspace === "" ? [] : [workspace])].join("\n\n");
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
