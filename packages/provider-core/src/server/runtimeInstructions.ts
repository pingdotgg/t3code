import type { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";

/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do still waits on checks, reviews, or a merge (queue, auto-merge, or someone else), even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
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
  const workspace =
    runtime.runtimePolicy === undefined ? "" : buildWorkspaceInstructions(runtime.runtimePolicy);
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in T3 Code's files viewer.</runtime_info>`;
  const base =
    runtime.pullRequestLinking === false
      ? runtimeInfo
      : `${runtimeInfo}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
  return workspace ? `${base}\n\n${workspace}` : base;
}

// Codex truncates context entries over 4,000 bytes; Codex sends this block as its own entry.
const WORKSPACE_INSTRUCTIONS_MAX_BYTES = 3_600;
const FOLDER_NAME_MAX_LENGTH = 64;
const textEncoder = new TextEncoder();

/** Lists a multi-repo thread's folders. Empty for single-repo threads, so their text is unchanged. */
export function buildWorkspaceInstructions(
  runtimePolicy: Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace">,
): string {
  const workspace = runtimePolicy.workspace;
  if (workspace === undefined) return "";
  const head = [
    "<workspace_folders>",
    "This thread uses these folders. Each Git repository has its own history and branches. Run Git commands inside the repository that you change. Do not change a read-only reference folder.",
  ];
  const tail = [
    ...(workspace.relativePathsDiffer
      ? [
          "These repositories are not in their usual places relative to each other. Relative paths between them, such as ../other-repo, can fail. Use the absolute paths above.",
        ]
      : []),
    "</workspace_folders>",
  ];
  const entries = [
    ...workspace.repositories.map((repository) =>
      folderLine(
        repository,
        repository.path === runtimePolicy.cwd
          ? "Git repository, your working directory"
          : "Git repository",
      ),
    ),
    ...workspace.referenceFolders.map((folder) => folderLine(folder, "read-only reference")),
  ];
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

function folderLine(
  folder: { readonly name: string; readonly path: string },
  kind: string,
): string {
  return `- ${folderName(folder.name)} (${kind}): ${folder.path.replaceAll(LINE_BREAKING, "?")}`;
}

// Control characters and Unicode line separators would let a folder name or path add lines.
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/** Folder names come from users and repos; keep each one a short label on one line. */
function folderName(name: string): string {
  const label = Array.from(
    name.replaceAll(LINE_BREAKING, " ").replaceAll(/[<>`]/g, " ").replaceAll(/\s+/g, " ").trim(),
  );
  if (label.length === 0) return "folder";
  return label.length > FOLDER_NAME_MAX_LENGTH
    ? `${label.slice(0, FOLDER_NAME_MAX_LENGTH - 1).join("")}…`
    : label.join("");
}

function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
