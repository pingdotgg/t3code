import {
  isOrchestrationV2WorkActive,
  isToolLifecycleItemType,
  type AssetResource,
  type RuntimeItemStatus,
  type ToolActivitySource,
  type ToolActivitySurface,
  type ToolActivityIcon,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import type { ToolCallVisibility } from "@t3tools/contracts/settings";
import {
  resolveT3McpSummaryAction,
  resolveT3McpToolDefinition,
  type T3McpToolDefinition,
  type T3McpToolSummaryAction,
} from "@t3tools/shared/t3McpToolPresentation";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/mediaPreview";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { classifyToolActivity, collectToolFilePaths } from "@t3tools/shared/toolActivity";
import { toolOutputIndicatesFailure } from "@t3tools/shared/toolOutput";

import {
  summarizeT3ToolCalls,
  t3ToolOutcomeLabel,
  t3ToolResultIndicatesFailure,
  type T3ToolSummaryCall,
} from "@t3tools/client-runtime/t3ToolSummary";
import { mFallback, msg } from "gt-i18n";
import { t3ToolSentence } from "./t3ToolSentences.ts";
import type { MFunctionType } from "gt-i18n/types";

export type WorkLogToolLifecycleStatus = RuntimeItemStatus | "stopped" | "idle";

export function toolItemForDisplay(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
    case "dynamic_tool": {
      const { output: _output, ...displayItem } = item;
      return displayItem;
    }
    case "file_change": {
      const { diffStr, oldStr: _oldStr, newStr: _newStr, ...displayItem } = item;
      // A failed edit's diffStr holds the provider's error, not a diff.
      return item.status === "failed" && diffStr?.trim()
        ? { ...displayItem, diffStr }
        : displayItem;
    }
    default:
      return item;
  }
}

type CompactionLabelItem = Pick<
  Extract<OrchestrationV2TurnItem, { type: "compaction" }>,
  "status" | "beforeTokenCount" | "afterTokenCount"
>;

export function contextCompactionTokenCounts(
  item: CompactionLabelItem,
): { readonly before: string; readonly after: string } | null {
  if (
    item.status === "running" ||
    item.beforeTokenCount === undefined ||
    item.afterTokenCount === undefined
  ) {
    return null;
  }
  return { before: formatTokens(item.beforeTokenCount), after: formatTokens(item.afterTokenCount) };
}

export function contextCompactionLabel(
  item: CompactionLabelItem,
  resolve: MFunctionType = mFallback,
): string {
  if (item.status === "failed") return resolve(msg("Context compaction failed"));
  if (item.status === "cancelled" || item.status === "interrupted")
    return resolve(msg("Context compaction stopped"));
  if (isOrchestrationV2WorkActive(item.status)) return resolve(msg("Compacting context"));
  const tokens = contextCompactionTokenCounts(item);
  return tokens
    ? resolve(msg("Context compacted {before} → {after} tokens", tokens))
    : resolve(msg("Context compacted"));
}

export interface WorkLogPresentationEntry {
  readonly questionAnswer?: import("@t3tools/contracts").UserInputAttachmentAnswerPayload;
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string;
  readonly rawCommand?: string;
  readonly detail?: string;
  readonly viewedImagePath?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly requestKind?: string;
  readonly itemType?: OrchestrationV2TurnItem["type"];
  readonly toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  readonly structuredPayload?: OrchestrationV2TurnItem;
  readonly toolSource?: ToolActivitySource;
  readonly toolSurface?: ToolActivitySurface;
  readonly toolIcon?: ToolActivityIcon;
}

export type ToolGroupAction =
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "read"
  | "edit"
  | "command"
  | "thread-create"
  | "browser"
  | "device"
  | "code-search"
  | "search"
  | "other"
  | "update";

export type ToolGroupSummaryKind =
  | "pull-request"
  | ToolGroupAction
  | "dynamic-tool"
  | "reasoning"
  | "agent-tool"
  | "tone-tool"
  | "mixed";

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function workEntryToolName(
  entry: Pick<WorkLogPresentationEntry, "label" | "toolTitle" | "toolData" | "structuredPayload">,
): string | undefined {
  const item = entry.structuredPayload;
  if (item?.type === "dynamic_tool" && item.toolName) return item.toolName;
  const data = asRecord(entry.toolData);
  if (typeof data?.server === "string" && typeof data.tool === "string") {
    return `${data.server}.${data.tool}`;
  }
  if (typeof data?.toolName === "string") return data.toolName;
  return resolveT3McpToolDefinition(entry.toolTitle) ? entry.toolTitle : entry.label;
}

function workEntryToolInput(
  entry: Pick<WorkLogPresentationEntry, "toolData" | "structuredPayload">,
): unknown {
  const item = entry.structuredPayload;
  const data = asRecord(entry.toolData);
  return item?.type === "dynamic_tool"
    ? item.input
    : (data?.arguments ?? data?.input ?? data?.rawInput);
}

function workEntryToolOutput(
  entry: Pick<WorkLogPresentationEntry, "toolData" | "structuredPayload">,
): unknown {
  const item = entry.structuredPayload;
  const data = asRecord(entry.toolData);
  return item?.type === "dynamic_tool"
    ? item.output
    : (data?.output ?? data?.result ?? data?.rawOutput ?? data?.content);
}

function t3ToolStatusKey(status: string | undefined) {
  return status === "inProgress" ||
    status === "completed" ||
    status === "failed" ||
    status === "declined" ||
    status === "stopped"
    ? status
    : "other";
}

function resolveT3McpToolPresentation(
  definition: T3McpToolDefinition | null,
  status: string | undefined,
  data: unknown,
  resolve: MFunctionType,
) {
  if (!definition) return null;
  const detail = definition.labels[3];

  const actionKind =
    definition.summaryAction === "link-pr" ||
    definition.summaryAction === "unlink-pr" ||
    definition.summaryAction === "list-prs" ||
    definition.summaryAction === "watch-pr" ||
    definition.summaryAction === "unwatch-pr"
      ? definition.summaryAction
      : undefined;
  const payload = asRecord(data);
  const input =
    asRecord(payload?.arguments) ?? asRecord(payload?.input) ?? asRecord(payload?.rawInput);
  const urlTarget =
    typeof input?.url === "string" ? sourceControlClients.parseChangeRequestUrl(input.url) : null;
  const number = urlTarget?.link.number ?? input?.number;
  const { shortLabel } = (urlTarget?.definition ?? sourceControlClients.get(undefined))
    .changeRequest;
  const pullRequestNumber =
    actionKind !== undefined &&
    actionKind !== "list-prs" &&
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
      ? number
      : null;
  const sentence = t3ToolSentence(definition.labels);
  const statusKey = t3ToolStatusKey(status);
  // A tool added to the shared table after `t3ToolSentences.ts` was generated.
  const [action, running, completed] = definition.labels;
  const fallbackVerb =
    status === "inProgress"
      ? running
      : status === "completed"
        ? completed
        : status === "failed"
          ? `Failed to ${action.toLowerCase()}`
          : status === "declined"
            ? `Declined to ${action.toLowerCase()}`
            : status === "stopped"
              ? `Stopped ${running.toLowerCase()}`
              : running;
  const displayName =
    sentence === undefined
      ? `${fallbackVerb} ${pullRequestNumber === null ? detail : `${shortLabel} #${pullRequestNumber}`}`
      : pullRequestNumber !== null && sentence.changeRequest !== undefined
        ? resolve(sentence.changeRequest, {
            status: statusKey,
            changeRequest: shortLabel,
            number: String(pullRequestNumber),
          })
        : resolve(sentence.detail, { status: statusKey });
  return {
    displayName,
    icon: definition.icon,
    ...(actionKind === undefined ? {} : { action: actionKind }),
  };
}

export function liveActivityToolStatus(status: string | undefined, presentTense: boolean) {
  if (status === "failed" || status === "declined" || status === "stopped" || status === "idle") {
    return status;
  }
  if (presentTense || status === "inProgress") return "inProgress";
  return "completed";
}

export function genericCommandStatusLabel(
  status: ReturnType<typeof liveActivityToolStatus>,
  resolve: MFunctionType = mFallback,
) {
  return resolve(
    status === "inProgress"
      ? msg("Running command")
      : status === "failed"
        ? msg("Failed command")
        : status === "declined"
          ? msg("Declined command")
          : status === "stopped"
            ? msg("Stopped command")
            : msg("Ran command"),
  );
}

const GENERIC_COMMAND_TITLES = new Set(["Ran command", "Run command", "Command"]);

export function commandlessCommandLabel(
  entry: Pick<
    WorkLogPresentationEntry,
    "itemType" | "command" | "toolTitle" | "label" | "structuredPayload"
  >,
  status: ReturnType<typeof liveActivityToolStatus>,
  resolve: MFunctionType = mFallback,
): string | null {
  if (entry.itemType !== "command_execution" || entry.command?.trim()) return null;
  // The provider's own title, before a client substitutes its translated fallback.
  const title = (
    entry.structuredPayload ? entry.structuredPayload.title : entry.toolTitle || entry.label
  )?.trim();
  return !title || GENERIC_COMMAND_TITLES.has(normalizeCompactToolLabel(title))
    ? genericCommandStatusLabel(status, resolve)
    : null;
}

export function resolveWorkEntryToolPresentation(
  entry: Pick<
    WorkLogPresentationEntry,
    "label" | "toolTitle" | "toolData" | "toolLifecycleStatus" | "structuredPayload"
  >,
  fallbackStatus?: "inProgress" | "completed",
  resolve: MFunctionType = mFallback,
) {
  const definition = resolveT3McpToolDefinition(
    workEntryToolName(entry),
    workEntryToolInput(entry),
  );
  const output = workEntryToolOutput(entry);
  const failed = definition !== null && t3ToolResultIndicatesFailure(output);
  const status = entry.toolLifecycleStatus ?? fallbackStatus;
  const presentation = resolveT3McpToolPresentation(
    definition,
    failed ? "failed" : status,
    entry.toolData,
    resolve,
  );
  if (definition === null || presentation === null || failed || status !== "completed") {
    return presentation;
  }
  const outcomeLabel = t3ToolOutcomeLabel(
    definition.summaryAction,
    { input: workEntryToolInput(entry), output, outcome: "completed" },
    resolve,
  );
  return outcomeLabel === undefined ? presentation : { ...presentation, displayName: outcomeLabel };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function workLogEntryIsToolLike(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

function workEntryIndicatesToolFailureFromOutput(
  entry: WorkLogPresentationEntry,
  includeCommand: boolean,
): boolean {
  if (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  ) {
    return true;
  }
  // Reasoning detail is the model's own prose (often tens of KB), not tool
  // output: scanning it is slow on long threads and misreads phrases like
  // "that exit code 2 is expected" as a failed tool.
  if (!workLogEntryIsToolLike(entry) || entry.itemType === "reasoning") return false;
  if (
    resolveT3McpToolDefinition(workEntryToolName(entry)) &&
    t3ToolResultIndicatesFailure(workEntryToolOutput(entry))
  ) {
    return true;
  }
  const item = entry.structuredPayload;
  if (item?.type === "command_execution") {
    // The exit code outranks text in the output or the command itself.
    if (item.exitCode !== undefined) return item.exitCode !== 0;
    if (item.outputIndicatesFailure) return true;
    if (item.output && toolOutputIndicatesFailure(item.output.slice(0, 32_768))) {
      return true;
    }
  }
  const output = includeCommand
    ? [entry.detail, entry.command].filter(Boolean).join("\n")
    : (entry.detail ?? "");
  return output.length > 0 && toolOutputIndicatesFailure(output);
}

// Rows are re-derived on every timeline update but entries are reused while
// their item is unchanged, so these per-entry checks are computed once.
const entryChecks = new WeakMap<
  WorkLogPresentationEntry,
  { failure?: boolean; displayFailure?: boolean; action?: ToolGroupAction }
>();

function checksFor(entry: WorkLogPresentationEntry) {
  let checks = entryChecks.get(entry);
  if (!checks) {
    checks = {};
    entryChecks.set(entry, checks);
  }
  return checks;
}

export function workEntryIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return (checksFor(entry).failure ??= workEntryIndicatesToolFailureFromOutput(entry, true));
}

export function workEntryDisplayIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return (checksFor(entry).displayFailure ??= workEntryIndicatesToolFailureFromOutput(
    entry,
    false,
  ));
}

const HIDEABLE_TOOL_CALL_ITEM_TYPES: ReadonlySet<WorkLogPresentationEntry["itemType"]> = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
]);

export function workEntryHiddenByToolCallVisibility(
  entry: WorkLogPresentationEntry,
  visibility: ToolCallVisibility,
): boolean {
  if (visibility === "showAll" || !HIDEABLE_TOOL_CALL_ITEM_TYPES.has(entry.itemType)) return false;
  if (visibility !== "hideSuccessful") return true;
  return entry.toolLifecycleStatus === "completed" && !workEntryDisplayIndicatesToolFailure(entry);
}

function workLogEntryIsLocalCodeSearch(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.itemType === "file_search" ||
    (entry.itemType === "web_search" &&
      /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label)))
  );
}

export function toolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  return (checksFor(entry).action ??= computeToolGroupAction(entry));
}

function computeToolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  if (entry.itemType === "thread_created") return "thread-create";
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation?.action !== undefined) return presentation.action;
  if (presentation?.icon === "browser") return "browser";
  if (presentation?.icon === "device") return "device";
  if (entry.requestKind === "file-read" || entry.viewedImagePath !== undefined) return "read";
  if (entry.itemType === "approval_request" || entry.itemType === "user_input_request") {
    return workLogEntryIsToolLike(entry) ? "other" : "update";
  }
  const data = asRecord(entry.toolData) ?? {};
  const toolName =
    entry.structuredPayload?.type === "dynamic_tool"
      ? entry.structuredPayload.toolName
      : typeof data.toolName === "string"
        ? data.toolName
        : entry.toolTitle;
  const classified = classifyToolActivity({
    itemType:
      entry.itemType === "command_execution" ||
      entry.itemType === "file_change" ||
      entry.itemType === "web_search"
        ? entry.itemType
        : entry.itemType === "dynamic_tool"
          ? "dynamic_tool_call"
          : undefined,
    title: entry.toolTitle ?? entry.label,
    data: {
      ...data,
      ...(toolName ? { toolName } : {}),
    },
  });
  if (classified === "read") return "read";
  if (classified === "file_change" || entry.itemType === "file_change") return "edit";
  if (classified === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (classified === "search") {
    return entry.itemType === "web_search" && !workLogEntryIsLocalCodeSearch(entry)
      ? "search"
      : "code-search";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  if ((entry.changedFiles?.length ?? 0) > 0) return "edit";
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

export function workEntryViewedImagePath(entry: WorkLogPresentationEntry): string | null {
  // The file may not exist until the call runs, and an open row never retries a failed asset URL.
  return entry.toolLifecycleStatus === "failed" || entry.toolLifecycleStatus === "inProgress"
    ? null
    : viewedImagePathOf(entry);
}

function viewedImagePathOf(entry: WorkLogPresentationEntry): string | null {
  const viewedImagePath = entry.viewedImagePath?.trim();
  if (
    viewedImagePath !== undefined &&
    !/[\r\n]/.test(viewedImagePath) &&
    isWorkspaceImagePreviewPath(viewedImagePath)
  ) {
    return viewedImagePath;
  }
  const detail = entry.detail?.trim();
  return toolGroupAction(entry) === "read" &&
    detail !== undefined &&
    !/[\r\n]/.test(detail) &&
    isWorkspaceImagePreviewPath(detail)
    ? detail
    : null;
}

/** Distinct images the agent opened across a tool group, in viewing order. */
export function workEntriesViewedImagePaths(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): string[] {
  return workEntriesViewedImages(entries).flatMap(({ path, pending }) => (pending ? [] : path));
}

export interface ViewedImage {
  readonly path: string;
  /** Only running Reads opened it, so its file may not exist yet; show a placeholder, not a request. */
  readonly pending: boolean;
}

/** {@link workEntriesViewedImagePaths}, plus the images a running Read is opening. */
export function workEntriesViewedImages(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ViewedImage[] {
  const pendingByPath = new Map<string, boolean>();
  for (const entry of entries) {
    if (entry.toolLifecycleStatus === "failed") continue;
    const path = viewedImagePathOf(entry);
    if (path === null) continue;
    const pending = entry.toolLifecycleStatus === "inProgress";
    pendingByPath.set(path, (pendingByPath.get(path) ?? true) && pending);
  }
  return [...pendingByPath].map(([path, pending]) => ({ path, pending }));
}

export interface ViewedImageAsset {
  readonly resource: Extract<AssetResource, { readonly _tag: "media-file" }>;
  readonly alt: string;
  readonly srcFragment: string;
}

/**
 * A tool reports the literal path it read, not a markdown destination. Escape what markdown
 * resolution would decode or split off, so a name like Grok's `sessions/%2FUsers...` survives.
 */
export function viewedImageMarkdownSource(path: string): string {
  return /^file:/i.test(path) ? path : path.replace(/[%#?]/g, encodeURIComponent);
}

export function resolveViewedImageAsset(
  path: string,
  input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot?: string | null | undefined;
  },
): ViewedImageAsset | null {
  const source = viewedImageMarkdownSource(path);
  const imageSource = classifyMarkdownImageSource(source, input.workspaceRoot ?? ".");
  if (imageSource._tag !== "WorkspaceFile") return null;
  const resolvedFilePath =
    input.workspaceRoot == null && imageSource.path.startsWith("./")
      ? imageSource.path.slice(2)
      : imageSource.path;

  const media = resolveMediaSource(source, {
    threadId: input.threadId,
    workspaceRoot: input.workspaceRoot,
    resolvedFilePath,
  });
  if (media === null || media.access !== "environment") return null;
  return { resource: media.resource, alt: media.name, srcFragment: media.srcFragment };
}

function toolGroupEntryFiles(
  action: "edit" | "read",
  entry: WorkLogPresentationEntry,
): ReadonlyArray<string> {
  if (action === "edit") return entry.changedFiles ?? [];
  const item = entry.structuredPayload;
  return collectToolFilePaths(
    item?.type === "dynamic_tool" ? { input: item.input } : entry.toolData,
  );
}

function toolGroupActionCount(
  action: ToolGroupAction,
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): number {
  if (action !== "edit" && action !== "read") return entries.length;
  const files = new Set<string>();
  let entriesWithoutFiles = 0;
  for (const entry of entries) {
    const entryFiles = toolGroupEntryFiles(action, entry);
    if (entryFiles.length === 0) {
      entriesWithoutFiles += 1;
    } else {
      for (const file of entryFiles) files.add(file);
    }
  }
  return files.size + entriesWithoutFiles;
}

function toolGroupActionLabel(
  action: ToolGroupAction,
  count: number,
  resolve: MFunctionType,
): string {
  switch (action) {
    case "link-pr":
      return resolve(
        msg(
          "{count, plural, one {Linked {count} pull request} other {Linked {count} pull requests}}",
          {
            count,
          },
        ),
      );
    case "unlink-pr":
      return resolve(
        msg(
          "{count, plural, one {Unlinked {count} pull request} other {Unlinked {count} pull requests}}",
          { count },
        ),
      );
    case "watch-pr":
      return resolve(
        msg(
          "{count, plural, one {Watching {count} pull request} other {Watching {count} pull requests}}",
          { count },
        ),
      );
    case "unwatch-pr":
      return resolve(
        msg(
          "{count, plural, one {Stopped watching {count} pull request} other {Stopped watching {count} pull requests}}",
          { count },
        ),
      );
    case "list-prs":
      return resolve(
        msg(
          "{count, plural, =1 {Checked linked pull requests} other {Checked linked pull requests {count} times}}",
          { count },
        ),
      );
    case "read":
      return resolve(
        msg("{count, plural, one {Read {count} file} other {Read {count} files}}", { count }),
      );
    case "edit":
      return resolve(
        msg("{count, plural, one {Changed {count} file} other {Changed {count} files}}", { count }),
      );
    case "command":
      return resolve(
        msg("{count, plural, one {Ran {count} command} other {Ran {count} commands}}", { count }),
      );
    case "thread-create":
      return resolve(
        msg("{count, plural, one {Created {count} thread} other {Created {count} threads}}", {
          count,
        }),
      );
    case "device":
      return resolve(
        msg(
          "{count, plural, one {Used device controls {count} time} other {Used device controls {count} times}}",
          { count },
        ),
      );
    case "browser":
      return resolve(
        msg("{count, plural, one {Used browser {count} time} other {Used browser {count} times}}", {
          count,
        }),
      );
    case "search":
      return resolve(
        msg(
          "{count, plural, one {Searched the web {count} time} other {Searched the web {count} times}}",
          { count },
        ),
      );
    case "code-search":
      return resolve(
        msg(
          "{count, plural, one {Searched code {count} time} other {Searched code {count} times}}",
          { count },
        ),
      );
    case "other":
      return resolve(
        msg("{count, plural, one {Used {count} tool} other {Used {count} tools}}", { count }),
      );
    case "update":
      return resolve(
        msg("{count, plural, one {Received {count} update} other {Received {count} updates}}", {
          count,
        }),
      );
  }
}

function joinClauses(items: ReadonlyArray<string>, resolve: MFunctionType): string {
  if (items.length < 2) return items[0] ?? "";
  if (items.length === 2) {
    return resolve(msg("{first} and {second}", { first: items[0]!, second: items[1]! }));
  }
  return resolve(
    msg("{items}, and {last}", { items: items.slice(0, -1).join(", "), last: items.at(-1)! }),
  );
}

function t3ToolSummaryCall(entry: WorkLogPresentationEntry): T3ToolSummaryCall {
  return {
    input: workEntryToolInput(entry),
    output: workEntryToolOutput(entry),
    outcome:
      entry.toolLifecycleStatus === "failed" ||
      entry.toolLifecycleStatus === "declined" ||
      entry.tone === "error"
        ? "failed"
        : entry.toolLifecycleStatus === "completed"
          ? "completed"
          : "unfinished",
  };
}

function summaryActionPriority(action: ToolGroupAction | T3McpToolSummaryAction): number {
  switch (action) {
    case "command":
    case "edit":
    case "delegate":
    case "task-cancel":
    case "thread-create":
    case "thread-send":
    case "thread-interrupt":
    case "workflow-stop":
    case "background-wait":
    case "schedule-create":
    case "schedule-update":
    case "schedule-delete":
    case "schedule-run":
    case "thread-configure":
    case "thread-fork":
    case "thread-merge":
    case "thread-organize":
    case "thread-group":
    case "thread-update":
    case "queue-edit":
    case "queue-cancel":
    case "queue-reorder":
    case "queue-steer":
    case "question-respond":
    case "worktree-handoff":
    case "project-create":
    case "project-update":
    case "project-delete":
    case "project-clone":
    case "environment-update":
    case "theme-set":
    case "attachment-prepare":
    case "attachment-discard":
    case "attachment-send":
      return 0;
    case "other":
    case "update":
      return 2;
    default:
      return 1;
  }
}

export function summarizeToolGroup(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
  resolve: MFunctionType = mFallback,
): {
  summary: string;
  hasFailure: boolean;
} {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) {
    return {
      summary:
        entries.length === 1
          ? resolve(msg("Thought", { $context: "noun, a reasoning step" }))
          : resolve(msg("Thought (×{count})", { count: entries.length })),
      hasFailure: false,
    };
  }
  entries = toolEntries;
  const groups = new Map<
    ToolGroupAction | T3McpToolSummaryAction,
    {
      action: ToolGroupAction;
      t3Action: T3McpToolSummaryAction | null;
      entries: WorkLogPresentationEntry[];
    }
  >();
  const sources = new Map<string, ToolActivitySource>();
  for (const entry of entries) {
    const t3Action = resolveT3McpSummaryAction(
      workEntryToolName(entry),
      t3ToolSummaryCall(entry).input,
    );
    if (entry.toolSource && t3Action === null) {
      sources.set(entry.toolSource.key, entry.toolSource);
      continue;
    }
    const action = toolGroupAction(entry);
    const key = t3Action ?? action;
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { action, t3Action, entries: [entry] });
  }
  const summaries = [...groups].map(([action, group], index) => ({
    index,
    count: group.entries.length,
    priority: summaryActionPriority(action),
    ...(group.t3Action
      ? summarizeT3ToolCalls(group.t3Action, group.entries.map(t3ToolSummaryCall), resolve)
      : {
          label: toolGroupActionLabel(
            group.action,
            toolGroupActionCount(group.action, group.entries),
            resolve,
          ),
          failedCount: group.entries.filter(workEntryDisplayIndicatesToolFailure).length,
        }),
  }));
  const selected = [...summaries]
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const labels = selected.map(({ label }) => label);
  if (sources.size > 0) {
    const sourceValues = [...sources.values()];
    const sourceNames = [...new Set(sourceValues.map((source) => source.name))];
    const names = joinClauses(sourceNames, resolve);
    const allIntegrations = sourceValues.every((source) => source.kind === "integration");
    labels.unshift(
      allIntegrations
        ? resolve(
            msg(
              "{count, plural, =1 {Used {names} integration} other {Used {names} integrations}}",
              { count: sourceNames.length, names },
            ),
          )
        : resolve(msg("Used {names}", { names })),
    );
  }
  const sourcedCount = entries.filter(
    (entry) =>
      entry.toolSource !== undefined &&
      resolveT3McpToolDefinition(workEntryToolName(entry)) === null,
  ).length;
  const remainingCount =
    entries.length - sourcedCount - selected.reduce((count, group) => count + group.count, 0);
  if (remainingCount > 0) {
    labels.push(
      resolve(
        msg(
          "{count, plural, one {Performed {count} other action} other {Performed {count} other actions}}",
          { count: remainingCount },
        ),
      ),
    );
  }
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  const summary = joinClauses(sentenceLabels, resolve);
  return { summary, hasFailure: summaries.some((group) => group.failedCount > 0) };
}

export function toolGroupSummaryKind(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummaryKind {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) return "reasoning";
  entries = toolEntries;
  if (
    entries.length > 0 &&
    entries.every((entry) => resolveWorkEntryToolPresentation(entry)?.icon === "pull-request")
  )
    return "pull-request";
  const actions = new Set(entries.map(toolGroupAction));
  if (actions.size !== 1) return "mixed";
  const action = actions.values().next().value!;
  if (action !== "other") return action;
  const fallbackKinds = new Set(
    entries.map((entry): ToolGroupSummaryKind => {
      if (entry.itemType === "dynamic_tool") return "dynamic-tool";
      if (entry.itemType === "subagent") return "agent-tool";
      if (entry.tone === "thinking") return "agent-tool";
      if (entry.tone === "tool") return "tone-tool";
      return "other";
    }),
  );
  return fallbackKinds.size === 1 ? fallbackKinds.values().next().value! : "mixed";
}

export function liveThoughtLine(markdown: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  // CJK sentences end in full-width marks with no space after them.
  const end = /[.?!]["'”’)]?(?=\s)|[。！？]["'”’）」』]?/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}
