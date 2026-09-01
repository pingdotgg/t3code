import {
  isToolLifecycleItemType,
  type AssetResource,
  type ThreadId,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

export function isWorktreeSetupActivity(kind: string): boolean {
  return kind === "setup-script.requested" || kind === "setup-script.started";
}

export interface WorkLogPresentationEntry {
  readonly label: string;
  readonly toolTitle?: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string;
  readonly detail?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly itemType?: ToolLifecycleItemType;
  readonly requestKind?: string;
  readonly turnId?: string | null;
  readonly toolCallId?: string;
  readonly toolLifecycleStatus?: string;
  readonly sourceActivityKind?: string;
  readonly taskId?: string;
}

export type ToolGroupAction =
  | "read"
  | "edit"
  | "command"
  | "code-search"
  | "search"
  | "other"
  | "update";

export type ToolGroupSummaryKind =
  | ToolGroupAction
  | "dynamic-tool"
  | "agent-tool"
  | "tone-tool"
  | "mixed";

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function workLogEntryIsToolLike(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

export function workLogEntryIsLocalCodeSearch(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.itemType === "web_search" &&
    /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label))
  );
}

export function toolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  if (
    entry.requestKind === "file-read" ||
    entry.itemType === "image_view" ||
    (entry.itemType === "dynamic_tool_call" &&
      entry.toolTitle?.trim().toLowerCase() === "read file")
  ) {
    return "read";
  }
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (entry.changedFiles?.length ?? 0) > 0
  ) {
    return "edit";
  }
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

export function workEntryViewedImagePath(entry: WorkLogPresentationEntry): string | null {
  const detail = entry.detail?.trim();
  return toolGroupAction(entry) === "read" &&
    detail !== undefined &&
    !/[\r\n]/.test(detail) &&
    isWorkspaceImagePreviewPath(detail)
    ? detail
    : null;
}

export interface ViewedImageAsset {
  readonly resource: Extract<AssetResource, { readonly _tag: "attachment" | "workspace-file" }>;
  readonly alt: string;
  readonly srcFragment: string;
}

const ABSOLUTE_IMAGE_SOURCE_PATTERN = /^(?:file:|[\\/]|[a-z]:[\\/])/i;
const T3_ATTACHMENT_IMAGE_PATH_PATTERN =
  /(?:^|[\\/])(?:dev|userdata)[\\/]attachments[\\/]([a-z0-9_-]{1,128})\.[a-z0-9]{1,10}$/i;

export function resolveViewedImageAsset(
  source: string,
  input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot?: string | null | undefined;
  },
): ViewedImageAsset | null {
  const imageSource = classifyMarkdownImageSource(source, input.workspaceRoot ?? ".");
  if (imageSource._tag !== "WorkspaceFile") return null;

  const path =
    input.workspaceRoot == null && imageSource.path.startsWith("./")
      ? imageSource.path.slice(2)
      : imageSource.path;
  const attachmentId = ABSOLUTE_IMAGE_SOURCE_PATTERN.test(source)
    ? (T3_ATTACHMENT_IMAGE_PATH_PATTERN.exec(path)?.[1] ?? null)
    : null;

  return {
    resource: attachmentId
      ? { _tag: "attachment", attachmentId }
      : { _tag: "workspace-file", threadId: input.threadId, path },
    alt: path.split(/[\\/]/).at(-1) ?? "image",
    srcFragment: markdownImageSourceFragment(source),
  };
}

function toolGroupActionCount(
  action: ToolGroupAction,
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): number {
  if (action !== "edit") return entries.length;

  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
      continue;
    }
    for (const file of entry.changedFiles) changedFiles.add(file);
  }
  return changedFiles.size + editsWithoutFileDetails;
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "search":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
    case "update":
      return `Received ${count} ${count === 1 ? "update" : "updates"}`;
  }
}

export function summarizeToolGroup(entries: ReadonlyArray<WorkLogPresentationEntry>): string {
  const summaryEntries = omitSupersededLifecycleMarkers(entries, (entry) => entry);
  const groupedEntries = new Map<ToolGroupAction, WorkLogPresentationEntry[]>();
  for (const entry of summaryEntries) {
    const action = toolGroupAction(entry);
    const group = groupedEntries.get(action);
    if (group) group.push(entry);
    else groupedEntries.set(action, [entry]);
  }
  const labels = [...groupedEntries].map(([action, actionEntries]) =>
    toolGroupActionLabel(action, toolGroupActionCount(action, actionEntries)),
  );
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  if (sentenceLabels.length < 2) return sentenceLabels[0] ?? "";
  if (sentenceLabels.length === 2) return sentenceLabels.join(" and ");
  return `${sentenceLabels.slice(0, -1).join(", ")}, and ${sentenceLabels.at(-1)}`;
}

export function omitSupersededLifecycleMarkers<T>(
  entries: readonly T[],
  workEntryFor: (entry: T) => WorkLogPresentationEntry,
): T[] {
  const laterTerminalIdentities = new Set<string>();
  const reversedEntries: T[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const workEntry = workEntryFor(entry);
    const normalizedLabel = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label);
    const identity = [
      workEntry.turnId ?? "no-turn",
      workEntry.itemType ?? "",
      normalizedLabel,
    ].join("\u001f");
    const activityKind = workEntry.sourceActivityKind;
    const isStatuslessIdlessMarker =
      workEntry.toolCallId === undefined &&
      workEntry.toolLifecycleStatus === undefined &&
      (activityKind === "tool.started" || activityKind === "tool.updated");
    if (isStatuslessIdlessMarker && laterTerminalIdentities.has(identity)) continue;

    reversedEntries.push(entry);
    if (
      activityKind === "tool.completed" ||
      (workEntry.toolLifecycleStatus !== undefined &&
        workEntry.toolLifecycleStatus !== "inProgress")
    ) {
      laterTerminalIdentities.add(identity);
    }
  }

  return reversedEntries.toReversed();
}

export function toolGroupSummaryKind(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummaryKind {
  const actions = new Set(entries.map(toolGroupAction));
  if (actions.size !== 1) return "mixed";

  const action = actions.values().next().value!;
  if (action !== "other") return action;

  const fallbackKinds = new Set(
    entries.map((entry): ToolGroupSummaryKind => {
      if (entry.itemType === "mcp_tool_call") return "other";
      if (entry.itemType === "dynamic_tool_call") return "dynamic-tool";
      if (entry.itemType === "collab_agent_tool_call" || entry.taskId) return "agent-tool";
      if (entry.tone === "thinking") return "agent-tool";
      if (entry.tone === "tool") return "tone-tool";
      return "other";
    }),
  );
  return fallbackKinds.size === 1 ? fallbackKinds.values().next().value! : "mixed";
}
