import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { checkpointFileTotals } from "@t3tools/client-runtime/state/thread-checkpoints";
import { isLiveSubagentTurnItem } from "@t3tools/client-runtime/state/subagentRuntime";
import * as DateTime from "effect/DateTime";
import * as Equal from "effect/Equal";
import {
  assistantCitationLabel,
  collectAssistantCitations,
} from "@t3tools/shared/assistantCitations";
import { shallow } from "zustand/vanilla/shallow";
import { claudeResumeCompactionAge } from "@t3tools/shared/claudeCompaction";
import {
  IDLE_COMPACTING_LABELS,
  IDLE_COMPACTION_TITLES,
} from "@t3tools/client-runtime/user-message";
import type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";
import { renderCodexDirectivesForCopy } from "@t3tools/shared/codexMarkdownDirectives";
import {
  commandDisplayText,
  commandProgramName,
} from "@t3tools/client-runtime/work-log/command-label";
import {
  liveActivityToolStatus,
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  contextCompactionTokenCounts,
  type ToolGroupSummaryKind,
} from "@t3tools/client-runtime/work-log/presentation";
import {
  deriveRevertTurnCountByUserMessageId,
  formatDuration,
  isStreamingMessageTextUpdate,
  isStreamingTurnItemTextUpdate,
  timelineEntryIsPersistentResourceCard,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import {
  type ChatMessage,
  type ProposedPlan,
  type ThreadShell,
  type TurnDiffSummary,
} from "../../types";
import {
  idleCompactionOf,
  isCompactionCommandMessage,
  type MessageId,
  type OrchestrationV2IdleCompaction,
  type WorktreeSetupSnapshot,
  type OrchestrationV2ProjectedTurnItem,
  type RunAttemptId,
  type RuntimeRequestId,
  RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/shell";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";
import { commandRunsTests, compactDynamicToolOutput } from "@t3tools/shared/toolOutput";
import { htmlRenderReferencesEqual, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { mcpAppReferencesEqual, type McpAppReference } from "@t3tools/shared/mcpApp";
import { dynamicToolTitle } from "@t3tools/shared/toolActivity";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  collectToolFilePaths,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { formatTokens } from "@t3tools/shared/usageFormat";
import {
  EMPTY_SLASH_COMMAND_CATALOG,
  parseSlashCommandMessage,
  type SlashCommandCatalog,
  type SlashCommandMessage,
  type SlashCommandState,
} from "./timelineSlashCommands";

function timelineEntryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.runId ?? null) : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.runId;
  }
  if (entry.kind === "html-render" || entry.kind === "mcp-app") return entry.runId;
  return entry.kind === "work" ? (entry.entry.runId ?? null) : null;
}

function workEntryIsActiveTurnActivity(entry: WorkLogEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    (entry.toolLifecycleStatus === undefined &&
      (entry.sourceActivityKind === "task.progress" || workLogEntryIsToolLike(entry)))
  );
}

function singleToolCallLabel(entry: WorkLogEntry): string {
  if (entry.itemType === "reasoning") return entry.detail?.trim().replace(/\s+/g, " ") || "Thought";
  const toolPresentation = resolveWorkEntryToolPresentation(entry, "completed");
  if (toolPresentation) return toolPresentation.displayName;
  const item = entry.structuredPayload;
  const title =
    item?.type === "dynamic_tool" ? dynamicToolTitle(item.toolName, item.input, item.title) : null;
  if (title) return title;
  if (entry.itemType === "web_search") return entry.toolTitle ?? "Web search";
  return workEntryDisplayLabel(entry, undefined);
}

function workEntryToolDataRecord(entry: WorkLogEntry): Record<string, unknown> | undefined {
  return entry.toolData !== null &&
    typeof entry.toolData === "object" &&
    !Array.isArray(entry.toolData)
    ? (entry.toolData as Record<string, unknown>)
    : undefined;
}

function workEntryReadRawPaths(entry: WorkLogEntry): readonly string[] {
  const fromChanged = entry.changedFiles ?? [];
  if (fromChanged.length > 0) return fromChanged;
  const structured = entry.structuredPayload;
  if (structured?.type === "dynamic_tool") {
    const structuredPaths = collectToolFilePaths({ input: structured.input });
    if (structuredPaths.length > 0) return structuredPaths;
  }
  return collectToolFilePaths(workEntryToolDataRecord(entry));
}

function workEntryReadPaths(entry: WorkLogEntry, workspaceRoot: string | undefined): string[] {
  return workEntryReadRawPaths(entry).map((filePath) =>
    formatWorkspaceRelativePath(filePath, workspaceRoot),
  );
}

export function workEntryDisplayLabel(entry: WorkLogEntry, workspaceRoot: string | undefined) {
  if (entry.itemType === "system_notice") return entry.label;
  if (entry.itemType === "reasoning" || entry.tone === "thinking") {
    const thought = entry.detail?.trim().replace(/\s+/g, " ");
    return thought || entry.label;
  }
  const toolPresentation = resolveWorkEntryToolPresentation(entry);
  if (toolPresentation) return toolPresentation.displayName;
  if (entry.command?.trim()) return commandDisplayText(entry.command);
  const action = toolGroupAction(entry);
  if (action === "code-search" || action === "search") {
    const searchLabel =
      entry.itemType === "file_search"
        ? entry.label
        : formatSearchToolLabel(workEntryToolDataRecord(entry));
    if (searchLabel) return searchLabel;
  }
  const readPaths = action === "read" ? workEntryReadPaths(entry, workspaceRoot) : [];
  if (action === "read" && readPaths[0]) {
    return formatReadToolLabel(readPaths[0], readPaths.length - 1);
  }
  const providerRetry =
    entry.projectedItem?.item.type === "error" && entry.projectedItem.item.retry !== undefined;
  const item = entry.structuredPayload;
  const title =
    item?.type === "dynamic_tool" ? dynamicToolTitle(item.toolName, item.input, item.title) : null;
  if (title) return title;
  const compactDetail = entry.detail?.trim();
  const detailIsSearchOutput =
    (action === "code-search" || action === "search") && /[\r\n]/.test(compactDetail ?? "");
  if (compactDetail && !providerRetry && action !== "read" && !detailIsSearchOutput) {
    return compactDetail;
  }
  const [firstPath] = entry.changedFiles ?? [];
  if (firstPath) {
    const path = formatWorkspaceRelativePath(firstPath, workspaceRoot);
    return entry.changedFiles!.length === 1
      ? path
      : `${path} +${entry.changedFiles!.length - 1} more`;
  }
  if (action === "read" && !entry.viewedImagePath) {
    return "Read file";
  }
  const heading = normalizeCompactToolLabel(entry.toolTitle || entry.label);
  return `${heading.charAt(0).toUpperCase()}${heading.slice(1)}`;
}

export function threadReadTargetId(entry: Pick<WorkLogEntry, "structuredPayload">) {
  const item = entry.structuredPayload;
  if (item?.type !== "dynamic_tool") return null;
  if (resolveT3McpToolDefinition(item.toolName)?.summaryAction !== "thread-read") return null;
  const input = item.input;
  const threadId =
    input !== null && typeof input === "object" && "threadId" in input ? input.threadId : null;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId.trim() : null;
}

const THREAD_READ_OBJECT = " a T3 thread";

export function threadReadTargetTitle(
  shell: Pick<ThreadShell, "title" | "archivedAt" | "deletedAt"> | null,
) {
  if (!shell || shell.archivedAt !== null || shell.deletedAt !== null) return null;
  return shell.title.trim() || null;
}

export function threadReadLabelPrefix(label: string) {
  return label.endsWith(THREAD_READ_OBJECT)
    ? `${label.slice(0, -THREAD_READ_OBJECT.length)} thread`
    : null;
}

export function workEntryReadOutput(
  entry: Pick<
    WorkLogEntry,
    "changedFiles" | "detail" | "viewedImagePath" | "structuredPayload" | "toolData"
  >,
  workspaceRoot: string | undefined,
): string | null {
  const paths = [
    ...new Set(
      workEntryReadRawPaths(entry as WorkLogEntry)
        .map((path) => {
          const trimmed = path.trim().replaceAll("\\", "/");
          if (!workspaceRoot || trimmed.startsWith("/") || isWindowsAbsolutePath(trimmed)) {
            return trimmed;
          }
          const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
          const relative = trimmed.replace(/^\.\//, "").replace(/^\/+/, "");
          return `${root}/${relative}`;
        })
        .filter((path) => path.length > 0),
    ),
  ];
  if (paths.length > 0) {
    return paths.join("\n");
  }
  return null;
}

export function liveWorkEntryLabel(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
  active: boolean,
) {
  const status = liveActivityToolStatus(entry.toolLifecycleStatus, active);
  if (entry.itemType === "reasoning") {
    return (
      entry.detail?.trim().replace(/\s+/g, " ") ||
      (status === "inProgress" ? "Thinking" : "Thought")
    );
  }
  const toolPresentation = resolveWorkEntryToolPresentation({
    ...entry,
    toolLifecycleStatus: status,
  });
  if (toolPresentation) return toolPresentation.displayName;
  const command = entry.command?.trim();
  if (command) {
    return `${commandEntryVerb(entry.toolLifecycleStatus, active)} ${commandProgramName(command) ?? "command"}`;
  }
  return workEntryDisplayLabel(entry, workspaceRoot);
}

/** The action word for a command row: "Running" while live, then how it ended. */
export function fileChangeEntryVerb(lifecycleStatus: WorkLogEntry["toolLifecycleStatus"]) {
  const status = liveActivityToolStatus(lifecycleStatus, false);
  return status === "inProgress"
    ? "Editing"
    : status === "failed"
      ? "Failed"
      : status === "declined"
        ? "Declined"
        : status === "stopped"
          ? "Stopped"
          : "Edited";
}

function commandEntryVerb(lifecycleStatus: WorkLogEntry["toolLifecycleStatus"], active: boolean) {
  const status = liveActivityToolStatus(lifecycleStatus, active);
  return status === "inProgress"
    ? "Running"
    : status === "failed"
      ? "Failed"
      : status === "declined"
        ? "Declined"
        : status === "stopped"
          ? "Stopped"
          : "Ran";
}

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean {
  if (entry.itemType === "reasoning") return Boolean(entry.detail?.trim());
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    entry.toolLifecycleStatus === "stopped" ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}
const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface WorkGroupScrollAnchor {
  readonly entryId: string;
  readonly offset: number;
}

export function resolveWorkGroupScrollIndex(
  entries: ReadonlyArray<{ readonly id: string }>,
  anchor: WorkGroupScrollAnchor | undefined,
): { index: number; viewOffset: number } | undefined {
  if (!anchor) return undefined;
  const index = entries.findIndex((entry) => entry.id === anchor.entryId);
  return index < 0 ? undefined : { index, viewOffset: -anchor.offset };
}

export function shouldFollowWorkGroupAppend(
  previous: ReadonlyArray<{ readonly id: string }>,
  entries: ReadonlyArray<{ readonly id: string }>,
  distanceFromEnd: number,
): boolean {
  return (
    previous.length > 0 &&
    entries.length > previous.length &&
    distanceFromEnd <= 1 &&
    previous.every((entry, index) => entry.id === entries[index]?.id)
  );
}

interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

// Streaming can briefly unset isAtEnd; re-arm near the content bottom.
const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  if (!state) {
    return undefined;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // LegendList double-subtracts the composer inset, so its isAtEnd is only a fallback.
  return contentLength - scroll - scrollLength <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

/** Recheck the rendered buffer: LegendList's unbuffered range can lag during scrolling. */
export function resolveTimelineMinimapVisibleRange(state: {
  readonly startBuffered: number | null | undefined;
  readonly endBuffered: number | null | undefined;
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}) {
  let start: number | null = null;
  let end: number | null = null;
  if (state.startBuffered == null || state.endBuffered == null || state.startBuffered < 0) {
    return { start, end };
  }
  const bottom = state.scroll + state.scrollLength;
  for (let index = state.startBuffered; index <= state.endBuffered; index += 1) {
    const top = state.positionAtIndex(index);
    const height = state.sizeAtIndex(index);
    if (
      top != null &&
      Number.isFinite(top) &&
      top < bottom &&
      top + Math.max(1, height != null && Number.isFinite(height) ? height : 1) > state.scroll
    ) {
      start ??= index;
      end = index;
    }
  }
  return { start, end };
}

export function isTimelineMinimapRowVisible(
  rowIndex: number,
  visibleStart: number | null | undefined,
  visibleEnd: number | null | undefined,
): boolean {
  return (
    visibleStart != null && visibleEnd != null && rowIndex >= visibleStart && rowIndex <= visibleEnd
  );
}

export function resolveTimelineMinimapCurrentIndex(input: {
  readonly visibleStart: number | null | undefined;
  readonly visibleEnd: number | null | undefined;
  readonly rowIndices: ReadonlyArray<number>;
}): number | null {
  if (input.visibleStart == null || input.visibleEnd == null) {
    return null;
  }
  let precedingIndex: number | null = null;
  for (const [index, rowIndex] of input.rowIndices.entries()) {
    if (rowIndex >= input.visibleStart) {
      // Prefer the first visible user message, otherwise the turn being read.
      return rowIndex <= input.visibleEnd ? index : precedingIndex;
    }
    precedingIndex = index;
  }
  return precedingIndex;
}

function resolveTimelineSideGutter(viewportWidth: number, contentWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(contentWidth)) {
    return 0;
  }
  return Math.max(0, (viewportWidth - Math.min(viewportWidth, contentWidth)) / 2);
}

export function resolveTimelineMinimapHasPersistentGutter(
  viewportWidth: number,
  contentWidth: number,
): boolean {
  return (
    resolveTimelineSideGutter(viewportWidth, contentWidth) >= TIMELINE_MINIMAP_PERSISTENT_GUTTER
  );
}

const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

export function resolveTimelineMinimapHitStripWidth(
  viewportWidth: number,
  contentWidth: number,
): number {
  const sideGutter = resolveTimelineSideGutter(viewportWidth, contentWidth);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

const TIMELINE_MINIMAP_NAVIGATION_REACH = 14;

export function resolveTimelineMinimapNavigationInteractive(collapsedWidth: number): boolean {
  return collapsedWidth >= TIMELINE_MINIMAP_NAVIGATION_REACH;
}

export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export type TimelineLatestRun = Pick<
  ThreadRunSummary,
  "runId" | "status" | "startedAt" | "completedAt" | "turnEnded"
>;

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

export type MessagesTimelineRow = MessagesTimelineRowContent & {
  readonly continuesWorkLog?: boolean;
  /** A user prompt followed directly by another prompt sits in the same prompt stack. */
  readonly continuesPromptStack?: boolean;
};

type MessagesTimelineRowContent =
  | {
      kind: "background-activity";
      id: string;
      createdAt: string | null;
      runIds: readonly RunId[];
      updateCount: number;
      active: boolean;
      expanded: boolean;
    }
  | {
      kind: "worktree-setup";
      id: string;
      createdAt: string | null;
      snapshot: WorktreeSetupSnapshot;
      embedded: boolean;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      isExpandedToolGroup: boolean;
      displayLabel?: string;
    }
  | {
      kind: "work-live";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      groupedEntries: WorkLogEntry[];
      groupId: string;
      expanded: boolean;
      active: boolean;
      thought?: WorkLogEntry;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      /** The running turn's live work, drawn under the bar instead of as rows. */
      window?: WorkingWindow;
      /** A running compaction owns the working row, so its divider appears only once it ends. */
      compacting?: true;
    }
  | {
      kind: "thinking";
      id: string;
      createdAt: string | null;
      groupId?: string;
      expanded?: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      runId?: RunId | null;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      summary: string;
      summaryKind: ToolGroupSummaryKind;
      toolSurface?: WorkLogEntry["toolSurface"];
      toolIcon?: WorkLogEntry["toolIcon"];
      hasFailure: boolean;
    }
  | {
      kind: "turn-fold";
      deferredWorkItemIds?: ReadonlyArray<string>;
      id: string;
      createdAt: string;
      runId: RunId;
      label: string;
      ending: TurnFoldEnding;
      diff: DiffLineStat | null;
      expanded: boolean;
      /** False when the fold holds only what its ending line already says. */
      foldable: boolean;
      failureMessage: string | null;
      noticeMessage: string | null;
    }
  | {
      kind: "attempt-fold";
      deferredWorkItemIds?: ReadonlyArray<string>;
      id: string;
      createdAt: string;
      runId: RunId;
      attemptId: RunAttemptId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "context-compaction";
      id: string;
      createdAt: string;
      label: string;
      tokenCounts: ReturnType<typeof contextCompactionTokenCounts>;
      active: boolean;
      /** Replaces "Context compacted" when T3 Code compacted without being asked. */
      title?: string;
      failed?: true;
      /** The provider's reason, when a failed compaction gave one. */
      failure?: string;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      showAssistantMeta: boolean;
      /** The latest finished reply of a still-running response shows only its timestamp. */
      showAssistantTimestamp: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
      /** Another of your messages follows directly, so the two sit closer together. */
      groupedWithNext?: boolean;
      /** Another of your messages sits directly above, so the joined corners tighten. */
      groupedWithPrevious?: boolean;
      /** Set when the message above is a steer too, so the label shows once. */
      continuesSteer?: boolean;
      /** Milliseconds from the turn's start to a steer landing in it. */
      steerOffsetMs?: number | undefined;
      /** A prompt that opens with a provider command. A standalone one renders as a work row. */
      command?: TimelineSlashCommand | undefined;
    }
  | {
      kind: "assistant-meta";
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      id: string;
      createdAt: string;
      message: ChatMessage;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
    }
  | {
      kind: "event";
      id: string;
      createdAt: string;
      projectedItem: OrchestrationV2ProjectedTurnItem;
      subagents?: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
      resourceSummary?: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "html-render";
      id: string;
      createdAt: string;
      htmlRender: HtmlRenderReference;
    }
  | {
      kind: "mcp-app";
      id: string;
      createdAt: string;
      sourceThreadId: ThreadId;
      itemId: TurnItemId;
      revision: string;
      mcpApp: McpAppReference;
    };

export interface TimelineSlashCommand extends SlashCommandMessage {
  readonly state: SlashCommandState;
  /** What the provider reported, such as a compaction's token counts. */
  readonly result: string | null;
}

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

function workGroupId(timelineEntryId: string): string {
  return `work-group:${timelineEntryId}`;
}

function expandedWorkGroupRow(
  groupId: string,
  createdAt: string,
  groupedEntries: WorkLogEntry[],
): Extract<MessagesTimelineRow, { kind: "work" }> {
  return {
    kind: "work",
    id: `${groupId}:details`,
    createdAt,
    groupedEntries,
    isExpandedToolGroup: true,
  };
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  const visible = showCopyButton && hasText && !streaming;
  return {
    text: hasText ? (visible ? renderCodexDirectivesForCopy(text) : text) : null,
    visible,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.runId
      ? `turn:${message.runId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

export type TurnFoldEnding = "worked" | "stopped" | "failed" | "limited";

interface TurnFold {
  runId: RunId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  /** Every entry in the segment, including the cards a fold never hides. */
  entryIds: ReadonlySet<string>;
  label: string;
  ending: TurnFoldEnding;
  diff: DiffLineStat | null;
  /**
   * The run's terminal error, usage-limit notices and stop. They stay out of
   * the timeline at any fold state; the fold's ending line carries their text.
   */
  endingEntryIds: ReadonlySet<string>;
  failureMessage: string | null;
  noticeMessage: string | null;
}

interface SupersededAttemptFold {
  readonly deferredWorkItemIds: ReadonlyArray<string>;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly anchorEntryId: string;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
}

// Interrupted streams can be `completed`; only the attempt's last output proves completion.
function completeSupersededReplyEntryIds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): ReadonlySet<string> {
  const lastOutputByAttemptId = new Map<RunAttemptId, TimelineEntry>();
  for (const entry of timelineEntries) {
    if (
      entry.attempt?.status !== "superseded" ||
      (entry.kind === "message" && entry.message.role === "user") ||
      (entry.kind === "work" &&
        (entry.entry.itemType === "system_notice" || entry.entry.itemType === "notification")) ||
      (entry.kind !== "message" && entry.kind !== "work")
    ) {
      continue;
    }
    const previous = lastOutputByAttemptId.get(entry.attempt.id);
    const deferredEnd =
      previous?.kind === "work"
        ? previous.entry.projectedItem?.item.deferredWork?.lastOrdinal
        : undefined;
    const ordinal =
      entry.kind === "work"
        ? entry.entry.projectedItem?.item.ordinal
        : entry.kind === "message"
          ? entry.projectedItem?.item.ordinal
          : undefined;
    if (deferredEnd !== undefined && ordinal !== undefined && deferredEnd > ordinal) continue;
    lastOutputByAttemptId.set(entry.attempt.id, entry);
  }
  const replyEntryIds = new Set<string>();
  for (const entry of lastOutputByAttemptId.values()) {
    const supersededAt = entry.attempt?.completedAt ?? null;
    const item = entry.kind === "message" ? entry.projectedItem?.item : undefined;
    if (
      entry.kind === "message" &&
      !entry.message.streaming &&
      item?.type === "assistant_message" &&
      item.status === "completed" &&
      item.completedAt !== null &&
      supersededAt !== null &&
      DateTime.isLessThan(item.completedAt, supersededAt)
    ) {
      replyEntryIds.add(entry.id);
    }
  }
  return replyEntryIds;
}

function deriveSupersededAttemptFolds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  unfoldedRunIds: ReadonlySet<RunId>,
  liveSubagentEntryIds: ReadonlySet<string>,
  completeReplyEntryIds: ReadonlySet<string>,
): ReadonlyMap<string, SupersededAttemptFold> {
  const completeAttemptIds = new Set(
    timelineEntries.flatMap((entry) =>
      entry.attempt !== undefined && completeReplyEntryIds.has(entry.id) ? [entry.attempt.id] : [],
    ),
  );
  const entriesByAttemptId = new Map<RunAttemptId, TimelineEntry[]>();
  for (const entry of timelineEntries) {
    if (
      entry.attempt?.status !== "superseded" ||
      completeAttemptIds.has(entry.attempt.id) ||
      unfoldedRunIds.has(entry.attempt.runId) ||
      (entry.kind === "message" && entry.message.role === "user") ||
      (entry.kind === "event" && entry.projectedItem.item.type === "handoff") ||
      entry.kind === "html-render" ||
      entry.kind === "mcp-app" ||
      timelineEntryIsPersistentResourceCard(entry) ||
      liveSubagentEntryIds.has(entry.id) ||
      (entry.kind === "work" && entry.entry.itemType === "system_notice")
    ) {
      continue;
    }
    const entries = entriesByAttemptId.get(entry.attempt.id) ?? [];
    entries.push(entry);
    entriesByAttemptId.set(entry.attempt.id, entries);
  }

  const foldsByAnchorEntryId = new Map<string, SupersededAttemptFold>();
  for (const entries of entriesByAttemptId.values()) {
    const firstEntry = entries[0];
    const attempt = firstEntry?.attempt;
    if (firstEntry === undefined || attempt === undefined) continue;
    foldsByAnchorEntryId.set(firstEntry.id, {
      deferredWorkItemIds: entries.flatMap((entry) =>
        entry.kind === "work" && entry.entry.projectedItem?.item.deferredWork
          ? [String(entry.entry.projectedItem.sourceItemId)]
          : [],
      ),
      runId: attempt.runId,
      attemptId: attempt.id,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds: new Set(entries.map((entry) => entry.id)),
    });
  }
  return foldsByAnchorEntryId;
}

// After send, the previous turn stays active until the server creates its replacement.
function deriveUnsettledRunId(
  latestRun: TimelineLatestRun | null,
  runningRunId: RunId | null = null,
): RunId | null {
  if (runningRunId !== null) return runningRunId;
  if (!latestRun) {
    return null;
  }
  const isSettled =
    latestRun.completedAt !== null &&
    latestRun.status !== "running" &&
    latestRun.status !== "starting" &&
    latestRun.status !== "waiting";
  return isSettled ? null : latestRun.runId;
}

// Children can outlive their launching turn; keep cards visible while the footer counts them.
function liveSubagentCardEntryIds(entries: ReadonlyArray<TimelineEntry>): ReadonlySet<string> {
  const visible = new Set<string>();
  let batch: Array<Extract<TimelineEntry, { kind: "event" }>> = [];
  const flush = () => {
    if (batch.length === 0) return;
    if (batch.some((entry) => isLiveSubagentTurnItem(entry.projectedItem.item))) {
      for (const entry of batch) visible.add(entry.id);
    }
    batch = [];
  };
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.projectedItem.item.type !== "subagent") {
      flush();
      continue;
    }
    const item = entry.projectedItem.item;
    const previous = batch.at(-1)?.projectedItem.item;
    if (
      previous !== undefined &&
      (previous.runId !== item.runId || previous.providerTurnId !== item.providerTurnId)
    ) {
      flush();
    }
    batch.push(entry);
  }
  flush();
  return visible;
}

function timelineEntryFoldRunId(entry: TimelineEntry, runlessKey: RunId | null): RunId | null {
  if (entry.kind === "work" && entry.entry.itemType === "system_notice") return null;
  if (entry.kind === "message" && entry.message.role === "assistant") {
    return entry.message.runId ?? runlessKey;
  }
  if (entry.kind === "work") {
    return entry.entry.runId ?? runlessKey;
  }
  if (
    entry.kind === "event" &&
    (timelineEntryIsPersistentResourceCard(entry) ||
      entry.projectedItem.item.type === "subagent" ||
      // The stopped fold says so itself and drops the divider.
      entry.projectedItem.item.type === "run_interrupt_result")
  ) {
    return entry.projectedItem.item.runId ?? runlessKey;
  }
  return null;
}

function timelineEntryIsSteer(entry: TimelineEntry): boolean {
  return (
    entry.kind === "message" &&
    entry.message.role === "user" &&
    (entry.message.inputIntent === "steer" ||
      entry.message.inputIntent === "promoted_queued_to_steer")
  );
}

function timelineEntryStartsResponse(entry: TimelineEntry): boolean {
  return (
    (entry.kind === "message" && entry.message.role === "user" && !timelineEntryIsSteer(entry)) ||
    (entry.kind === "work" && entry.entry.itemType === "notification")
  );
}

function timelineEntryEnd(entry: TimelineEntry): string {
  return entry.kind === "message" ? entry.message.updatedAt : entry.createdAt;
}

function timelineEntryIsCompaction(entry: TimelineEntry): boolean {
  return entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction";
}

function responseBoundaryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") return entry.message.runId ?? null;
  if (entry.kind === "work") return entry.entry.runId ?? null;
  return null;
}

// Group promptless restarts under the initiating prompt until settled.
function lastResponseBoundaryIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(timelineEntryStartsResponse);
}

function deriveActiveVisualResponseRunIds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  unsettledRunId: RunId | null;
  isWorking: boolean;
}): ReadonlySet<RunId> {
  const runIds = new Set<RunId>();
  if (input.unsettledRunId === null) {
    return runIds;
  }

  runIds.add(input.unsettledRunId);
  if (!input.isWorking) {
    return runIds;
  }

  const latestResponseBoundaryIndex = lastResponseBoundaryIndex(input.timelineEntries);
  for (
    let index = latestResponseBoundaryIndex + 1;
    index < input.timelineEntries.length;
    index += 1
  ) {
    const runId = timelineEntryRunId(input.timelineEntries[index]!);
    if (runId !== null) {
      runIds.add(runId);
    }
  }
  return runIds;
}

function timelineEntryFailedItem(entry: TimelineEntry) {
  const item =
    entry.kind === "event"
      ? entry.projectedItem.item
      : entry.kind === "work"
        ? entry.entry.projectedItem?.item
        : null;
  return item?.type === "error" && item.status === "failed" && item.parentItemId === null
    ? item
    : null;
}

function failedTimelineRunIds(
  entries: ReadonlyArray<TimelineEntry>,
  latestRun: TimelineLatestRun | null,
) {
  const failed = new Set<RunId>();
  if (latestRun?.status === "failed") failed.add(latestRun.runId);
  for (const entry of entries) {
    const runId = timelineEntryFailedItem(entry)?.runId;
    if (runId) failed.add(runId);
  }
  return failed;
}

/** Usage-limit pauses keep their tool groups; any other failure itemizes the run's work. */
function itemizedFailedRunIds(
  entries: ReadonlyArray<TimelineEntry>,
  failedRunIds: ReadonlySet<RunId>,
) {
  const usageLimited = new Set<RunId>();
  const otherFailures = new Set<RunId>();
  for (const entry of entries) {
    const item = timelineEntryFailedItem(entry);
    if (item?.runId) {
      (item.failure.class === "usage_limit" ? usageLimited : otherFailures).add(item.runId);
    }
  }
  return new Set(
    [...failedRunIds].filter((runId) => !usageLimited.has(runId) || otherFailures.has(runId)),
  );
}

/** Runs the user stopped: their interrupt result, or the latest run's own status. */
function stoppedTimelineRunIds(
  entries: ReadonlyArray<TimelineEntry>,
  latestRun: TimelineLatestRun | null,
) {
  const stopped = new Set<RunId>();
  if (latestRun?.status === "interrupted" || latestRun?.status === "cancelled") {
    stopped.add(latestRun.runId);
  }
  for (const entry of entries) {
    if (entry.kind !== "event") continue;
    const item = entry.projectedItem.item;
    if (item.type === "run_interrupt_result" && item.runId) stopped.add(item.runId);
  }
  return stopped;
}

function timelineEntryTurnItem(entry: TimelineEntry) {
  return entry.kind === "event"
    ? entry.projectedItem.item
    : entry.kind === "work"
      ? entry.entry.projectedItem?.item
      : undefined;
}

/** Runs whose terminal failure is a provider usage limit. */
function usageLimitedTimelineRunIds(entries: ReadonlyArray<TimelineEntry>): ReadonlySet<RunId> {
  const limited = new Set<RunId>();
  for (const entry of entries) {
    const item = timelineEntryTurnItem(entry);
    if (
      item?.type === "error" &&
      item.status === "failed" &&
      item.failure.class === "usage_limit" &&
      item.parentItemId === null &&
      item.runId !== null
    ) {
      limited.add(item.runId);
    }
  }
  return limited;
}

function timelineEntryIsFailure(entry: TimelineEntry): boolean {
  const item = timelineEntryTurnItem(entry);
  return (
    (item?.type === "error" && item.status === "failed") ||
    (entry.kind === "work" &&
      (entry.entry.tone === "error" || entry.entry.sourceActivityKind === "runtime.error"))
  );
}

export interface DiffLineStat {
  readonly additions: number;
  readonly deletions: number;
}

/** Sums the counts providers report on file_change items; null when none report any. */
function sumFileChangeLineStat(entries: Iterable<WorkLogEntry>): DiffLineStat | null {
  let additions = 0;
  let deletions = 0;
  let reported = false;
  for (const entry of entries) {
    const item = entry.projectedItem?.item;
    if (item?.type !== "file_change") continue;
    if (item.additions === undefined && item.deletions === undefined) continue;
    reported = true;
    additions += item.additions ?? 0;
    deletions += item.deletions ?? 0;
  }
  return reported ? { additions, deletions } : null;
}

function sumCheckpointLineStat(summary: TurnDiffSummary): DiffLineStat | null {
  const { count, additions, deletions } = checkpointFileTotals(summary);
  return count === 0 ? null : { additions, deletions };
}

/**
 * and work still in progress stay visible. A stopped, failed or limited turn
 * folds the same way and names how it ended. A prompt without a run (a
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestRun: TimelineLatestRun | null;
  unfoldedRunIds: ReadonlySet<RunId>;
  runlessWorkActive: boolean;
  failedRunIds: ReadonlySet<RunId>;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  liveSubagentEntryIds: ReadonlySet<string>;
  completeSupersededReplyEntryIds: ReadonlySet<string>;
}): ReadonlyMap<string, TurnFold> {
  const interruptedRunIds = new Set<RunId>();
  const usageLimitedRunIds = usageLimitedTimelineRunIds(input.timelineEntries);
  const promptIndexByRunId = new Map<RunId, number>();
  for (const [index, entry] of input.timelineEntries.entries()) {
    if (timelineEntryStartsResponse(entry)) {
      const runId = responseBoundaryRunId(entry);
      if (runId !== null && !promptIndexByRunId.has(runId)) promptIndexByRunId.set(runId, index);
    }
    if (
      entry.kind === "event" &&
      entry.projectedItem.item.runId !== null &&
      entry.projectedItem.item.type === "run_interrupt_result"
    ) {
      interruptedRunIds.add(entry.projectedItem.item.runId);
    }
  }

  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    // Entry timestamps omit startup and can collapse steered turns to an instant.
    startBoundary: string | null;
    anchorEntryId: string;
    /**
     * Each steer after the turn has produced output starts a new segment at
     * this index into `entries`, so the steer sits between the work it split.
     */
    steerSegments: Array<{ startIndex: number; steer: TimelineEntry }>;
  }
  const groupsByRunId = new Map<RunId, TurnGroup>();
  const runlessFailedKeys = new Set<RunId>();

  // Key runless responses per prompt to prevent V2 runs unfolding imported turns.
  let runlessKey: RunId | null = null;
  let responseKey: RunId | null = null;
  let pendingBoundary: { createdAt: string; anchorEntryId: string } | null = null;
  for (const [index, entry] of input.timelineEntries.entries()) {
    if (timelineEntryStartsResponse(entry)) {
      const nextEntry = input.timelineEntries[index + 1];
      pendingBoundary = nextEntry
        ? { createdAt: entry.createdAt, anchorEntryId: nextEntry.id }
        : null;
      const boundaryRunId = responseBoundaryRunId(entry);
      runlessKey = boundaryRunId == null ? RunId.make(`runless:${entry.id}`) : null;
      responseKey = boundaryRunId ?? runlessKey;
      continue;
    }
    if (entry.kind === "message" && timelineEntryIsSteer(entry)) {
      const steerRunId = entry.message.runId ?? responseKey;
      const group = steerRunId === null ? undefined : groupsByRunId.get(steerRunId);
      if (group !== undefined && group.entries.length > 0) {
        // Back-to-back steers split once, after the last of them.
        if (group.steerSegments.at(-1)?.startIndex === group.entries.length) {
          group.steerSegments.pop();
        }
        group.steerSegments.push({ startIndex: group.entries.length, steer: entry });
      }
      continue;
    }
    // A failed run's notices join its fold, which names the failure itself.
    const ownRunId =
      timelineEntryFoldRunId(entry, runlessKey) ??
      (entry.kind === "work" &&
      entry.entry.itemType === "system_notice" &&
      entry.entry.runId &&
      input.failedRunIds.has(entry.entry.runId)
        ? entry.entry.runId
        : null);
    if (!ownRunId) {
      continue;
    }
    // Resumed subagents keep their position and fold with their original turn.
    const runId =
      responseKey !== null && (promptIndexByRunId.get(ownRunId) ?? -1) > index
        ? responseKey
        : ownRunId;
    if (runId === runlessKey && timelineEntryFailedItem(entry) !== null) {
      runlessFailedKeys.add(runId);
    }
    let group = groupsByRunId.get(runId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        startBoundary: pendingBoundary?.createdAt ?? null,
        anchorEntryId: pendingBoundary?.anchorEntryId ?? entry.id,
        steerSegments: [],
      };
      pendingBoundary = null;
      groupsByRunId.set(runId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const readyCheckpointByRunId = new Map<RunId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    if (summary.runId && summary.status === "ready")
      readyCheckpointByRunId.set(summary.runId, summary);
  }
  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [runId, group] of groupsByRunId) {
    if (input.unfoldedRunIds.has(runId) || (input.runlessWorkActive && runId === runlessKey)) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const failed = input.failedRunIds.has(runId) || runlessFailedKeys.has(runId);
    const prompt = input.timelineEntries[promptIndexByRunId.get(runId) ?? -1];
    const compactionHasStopRow =
      prompt?.kind === "message" &&
      isCompactionCommandMessage(prompt.message) &&
      idleCompactionOf(prompt.message) !== undefined &&
      group.entries.some(timelineEntryIsCompaction);
    const hiddenEntryIds = new Set<string>();
    const endingEntryIds = new Set<string>();
    let failureMessage: string | null = null;
    let noticeMessage: string | null = null;
    const terminalEntryIndex = group.terminalEntry
      ? group.entries.findIndex((entry) => entry.id === group.terminalEntry?.id)
      : group.entries.length;
    for (const [index, entry] of group.entries.entries()) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      if (failed) {
        const failedItem = timelineEntryFailedItem(entry);
        const notice =
          entry.kind === "work" && entry.entry.itemType === "system_notice" ? entry.entry : null;
        if (failedItem !== null || notice !== null) {
          if (failedItem !== null) failureMessage = failedItem.failure.message;
          if (notice !== null) noticeMessage = notice.label;
          hiddenEntryIds.add(entry.id);
          endingEntryIds.add(entry.id);
          continue;
        }
      }
      // A failed turn keeps its other failures below the fold; the rest folds away.
      if (failed && timelineEntryIsFailure(entry)) {
        continue;
      }
      const isCompaction = timelineEntryIsCompaction(entry);
      const isInterruptResult =
        entry.kind === "event" && entry.projectedItem.item.type === "run_interrupt_result";
      if (isInterruptResult && compactionHasStopRow) continue;
      const isFoldableTrailingActivity =
        isInterruptResult ||
        (entry.kind === "work" &&
          entry.entry.toolLifecycleStatus !== "inProgress" &&
          !workEntryDisplayIndicatesToolFailure(entry.entry));
      if (!isCompaction && index > terminalEntryIndex && !isFoldableTrailingActivity) {
        continue;
      }
      if (
        isCompaction ||
        timelineEntryIsPersistentResourceCard(entry) ||
        input.liveSubagentEntryIds.has(entry.id) ||
        input.completeSupersededReplyEntryIds.has(entry.id)
      ) {
        continue;
      }
      if (entry.kind === "work" && entry.entry.itemType === "notification") continue;
      if (entry.kind === "work" && entry.entry.questionAnswer !== undefined) continue;
      hiddenEntryIds.add(entry.id);
      // A stopped fold says so itself; its interrupt divider never shows.
      if (isInterruptResult && !failed) endingEntryIds.add(entry.id);
    }
    const hidesNonCompactionWork = (entries: ReadonlyArray<TimelineEntry>) =>
      entries.some((entry) => hiddenEntryIds.has(entry.id) && !timelineEntryIsCompaction(entry));
    // A reply still owns its duration bar when there was no work to expand.
    if (!hidesNonCompactionWork(group.entries) && group.terminalEntry === null) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestRun?.runId === runId && input.latestRun.status === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd = timelineEntryEnd(lastEntry);
    const elapsedMs =
      input.latestRun?.runId === runId && input.latestRun.startedAt && input.latestRun.completedAt
        ? computeElapsedMs(input.latestRun.startedAt, input.latestRun.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const ending: TurnFoldEnding = failed
      ? usageLimitedRunIds.has(runId)
        ? "limited"
        : "failed"
      : isLatestInterruptedTurn || interruptedRunIds.has(runId)
        ? "stopped"
        : "worked";
    const label =
      ending === "stopped"
        ? duration
          ? `Stopped at ${duration}`
          : "Stopped"
        : ending === "failed"
          ? duration
            ? `Failed after ${duration}`
            : "Failed"
          : ending === "limited"
            ? duration
              ? `Limited at ${duration}`
              : "Limited"
            : duration
              ? `Worked for ${duration}`
              : "Worked";
    // The checkpoint diff is what the changed-files card shows; provider
    // counts are the fallback for turns without a checkpoint.
    const checkpoint = readyCheckpointByRunId.get(runId);
    const diff =
      (checkpoint ? sumCheckpointLineStat(checkpoint) : null) ??
      sumFileChangeLineStat(
        group.entries.flatMap((entry) => (entry.kind === "work" ? [entry.entry] : [])),
      );

    // The top row keeps the whole turn's time, steers included. Work after a
    // steer folds under its own row below that steer, keyed apart from the run
    // so each segment opens on its own.
    const segmentHiddenIds = (entries: ReadonlyArray<TimelineEntry>) =>
      new Set(entries.flatMap((entry) => (hiddenEntryIds.has(entry.id) ? [entry.id] : [])));
    const firstSegment = group.entries.slice(0, group.steerSegments[0]?.startIndex);
    foldsByAnchorEntryId.set(group.anchorEntryId, {
      runId,
      anchorEntryId: group.anchorEntryId,
      createdAt: group.startBoundary ?? firstEntry.createdAt,
      hiddenEntryIds: segmentHiddenIds(firstSegment),
      entryIds: new Set(firstSegment.map((entry) => entry.id)),
      label,
      ending,
      diff,
      endingEntryIds,
      failureMessage,
      noticeMessage,
    });
    for (const [index, { startIndex, steer }] of group.steerSegments.entries()) {
      const entries = group.entries.slice(startIndex, group.steerSegments[index + 1]?.startIndex);
      const anchorEntry = entries[0];
      if (anchorEntry === undefined || !hidesNonCompactionWork(entries)) continue;
      const segmentMs = computeElapsedMs(
        steer.createdAt,
        entries.map(timelineEntryEnd).reduce<string | null>(maxIsoTimestamp, null) ??
          steer.createdAt,
      );
      foldsByAnchorEntryId.set(anchorEntry.id, {
        runId: RunId.make(`${runId}:steer:${steer.id}`),
        anchorEntryId: anchorEntry.id,
        createdAt: steer.createdAt,
        hiddenEntryIds: segmentHiddenIds(entries),
        entryIds: new Set(entries.map((entry) => entry.id)),
        label: segmentMs !== null ? `Continued for ${formatDuration(segmentMs)}` : "Continued",
        // The turn summary owns its terminal message; each segment keeps its own disclosure.
        ending: failed ? ending : "worked",
        diff: sumFileChangeLineStat(
          entries.flatMap((entry) => (entry.kind === "work" ? [entry.entry] : [])),
        ),
        endingEntryIds: new Set(
          entries.flatMap((entry) => (endingEntryIds.has(entry.id) ? [entry.id] : [])),
        ),
        failureMessage: null,
        noticeMessage: null,
      });
    }
  }
  return foldsByAnchorEntryId;
}

function attachTrailingToolGroupsToAssistant(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MessagesTimelineRow[] {
  const messageRowsWithoutMeta = new Set<string>();
  const metaRowsAfterIndex = new Map<
    number,
    Extract<MessagesTimelineRow, { kind: "assistant-meta" }>
  >();

  for (const [messageIndex, row] of rows.entries()) {
    const runId = row.kind === "message" ? (row.message.runId ?? null) : null;
    if (
      row.kind !== "message" ||
      row.message.role !== "assistant" ||
      !row.showAssistantMeta ||
      runId === null
    ) {
      continue;
    }

    let lastTrailingWorkIndex = -1;
    let hasTrailingToolGroup = false;
    for (let index = messageIndex + 1; index < rows.length; index += 1) {
      const candidate = rows[index];
      if (!candidate || candidate.kind === "message") {
        break;
      }
      if (candidate.kind === "work-toggle" && candidate.runId === runId) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "event" &&
        candidate.resourceSummary &&
        candidate.projectedItem.item.runId === runId
      ) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "work" &&
        candidate.groupedEntries.some((entry) => entry.runId === runId)
      ) {
        if (
          !candidate.isExpandedToolGroup &&
          candidate.groupedEntries.some(
            (entry) =>
              workLogEntryIsToolLike(entry) ||
              (entry.projectedItem?.item.type === "error" &&
                entry.projectedItem.item.status === "failed"),
          )
        ) {
          hasTrailingToolGroup = true;
        }
        if (hasTrailingToolGroup) {
          lastTrailingWorkIndex = index;
        }
      }
    }

    if (lastTrailingWorkIndex < 0) {
      continue;
    }

    messageRowsWithoutMeta.add(row.id);
    metaRowsAfterIndex.set(lastTrailingWorkIndex, {
      kind: "assistant-meta",
      id: `assistant-meta:${row.message.id}`,
      ...(row.projectedItem === undefined ? {} : { projectedItem: row.projectedItem }),
      createdAt: rows[lastTrailingWorkIndex]?.createdAt ?? row.message.updatedAt,
      message: row.message,
      showAssistantCopyButton: row.showAssistantCopyButton,
      assistantCopyStreaming: row.assistantCopyStreaming,
    });
  }

  const result: MessagesTimelineRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && messageRowsWithoutMeta.has(row.id)) {
      result.push({ ...row, showAssistantMeta: false, showAssistantCopyButton: false });
    } else {
      result.push(row);
    }
    const metaRow = metaRowsAfterIndex.get(index);
    if (metaRow) {
      result.push(metaRow);
    }
  }
  return result;
}

// Hide delegation rows only when task ids identify durable child cards; prompts can repeat.
function withoutSubagentDelegationRows(entries: ReadonlyArray<TimelineEntry>) {
  const childrenByRun = new Map<RunId, Set<string>>();
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.projectedItem.item.type !== "subagent") continue;
    const item = entry.projectedItem.item;
    if (item.origin !== "app_owned" || item.runId === null) continue;
    const children = childrenByRun.get(item.runId) ?? new Set<string>();
    children.add(item.subagentId);
    childrenByRun.set(item.runId, children);
  }
  return entries.filter((entry) => {
    if (entry.kind !== "work" || workEntryDisplayIndicatesToolFailure(entry.entry)) return true;
    const item = entry.entry.projectedItem?.item ?? entry.entry.structuredPayload;
    if (
      item?.type !== "dynamic_tool" ||
      item.runId === null ||
      (item.status !== "running" && item.status !== "completed") ||
      resolveT3McpToolDefinition(item.toolName)?.summaryAction !== "delegate"
    )
      return true;
    const output = compactDynamicToolOutput(item.output);
    if (output?.isError) return true;
    if (output?.taskId !== undefined) {
      return !childrenByRun.get(item.runId)?.has(output.taskId);
    }
    return true;
  });
}

const supersededReasoningEntries = new WeakMap<TimelineEntry, TimelineEntry>();

function settleSupersededReasoning(entries: ReadonlyArray<TimelineEntry>) {
  return entries.map((entry, index) => {
    if (
      index === entries.length - 1 ||
      entry.kind !== "work" ||
      entry.entry.itemType !== "reasoning" ||
      entry.entry.toolLifecycleStatus !== "inProgress"
    ) {
      return entry;
    }
    let settled = supersededReasoningEntries.get(entry);
    if (!settled) {
      settled = { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "completed" } };
      supersededReasoningEntries.set(entry, settled);
    }
    return settled;
  });
}

function timelineRowEntries(entries: ReadonlyArray<TimelineEntry>) {
  return withoutSubagentDelegationRows(settleSupersededReasoning(entries));
}

function deriveTimelineTurnFolds(
  input: Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "latestRun" | "isWorking" | "runlessWorkActive" | "runningRunId"
  >,
) {
  const timelineEntries = timelineRowEntries(input.timelineEntries);
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const failedRunIds = failedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries,
    unsettledRunId,
    isWorking: input.isWorking,
  });
  return deriveTurnFolds({
    timelineEntries,
    terminalAssistantMessageIds: deriveTerminalAssistantMessageIds(timelineEntries),
    latestRun: input.latestRun ?? null,
    unfoldedRunIds: activeVisualResponseRunIds,
    failedRunIds,
    runlessWorkActive: input.isWorking && input.runlessWorkActive === true,
    // Fold membership does not depend on the diff stat the fold header shows.
    turnDiffSummaries: [],
    liveSubagentEntryIds: liveSubagentCardEntryIds(timelineEntries),
    completeSupersededReplyEntryIds: completeSupersededReplyEntryIds(timelineEntries),
  });
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  pendingApprovalRequestIds?: ReadonlySet<RuntimeRequestId>;
  latestRun?: TimelineLatestRun | null;
  runningRunId?: RunId | null;
  expandedRunIds?: ReadonlySet<RunId>;
  expandedAttemptIds?: ReadonlySet<RunAttemptId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  /** Native subagent work has no app run; runless entries form the live response. */
  runlessWorkActive?: boolean;
  activeTurnStartedAt?: string | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  supportsConversationRollback: boolean;
  threadStartCheckpointReady?: boolean;
  availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  worktreeSetup?: WorktreeSetupSnapshot | null;
  /** Commands and skills of the thread's provider, for telling a command from a path. */
  slashCommands?: SlashCommandCatalog;
}): MessagesTimelineRow[] {
  const timelineEntries = timelineRowEntries(input.timelineEntries);
  const isPendingApproval = (entry: WorkLogEntry) => {
    const item = entry.projectedItem?.item;
    return (
      item?.type === "approval_request" &&
      input.pendingApprovalRequestIds?.has(item.requestId) === true
    );
  };
  const turnDiffSummaryByAssistantMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    if (summary.assistantMessageId) {
      turnDiffSummaryByAssistantMessageId.set(summary.assistantMessageId, summary);
    }
  }
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const revertTurnCountByUserMessageId = input.supportsConversationRollback
    ? deriveRevertTurnCountByUserMessageId({
        timelineEntries: timelineEntries,
        checkpoints: input.turnDiffSummaries,
        threadStartCheckpointReady: input.threadStartCheckpointReady === true,
        unsettledRunId,
        availableRevertTurnCounts: input.availableRevertTurnCounts,
      })
    : new Map<MessageId, number>();
  const nextRows: MessagesTimelineRow[] = [];
  const steerOffsetStartByRunId = deriveSteerOffsetStartByRunId(
    timelineEntries,
    input.latestRun ?? null,
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(timelineEntries);
  const failedRunIds = failedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  const itemizedRunIds = itemizedFailedRunIds(timelineEntries, failedRunIds);
  const stoppedRunIds = stoppedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  // A standalone `/compact` and the compaction its run reports are one row.
  const compactionByRunId = new Map<RunId, WorkLogEntry>();
  for (const entry of timelineEntries) {
    if (entry.kind !== "work" || entry.entry.sourceActivityKind !== "context-compaction") continue;
    const runId = entry.entry.runId;
    if (runId != null && !compactionByRunId.has(runId)) compactionByRunId.set(runId, entry.entry);
  }
  const mergedCompactionIds = new Set<string>();
  const liveSubagentEntryIds = liveSubagentCardEntryIds(timelineEntries);
  const completeSupersededReplyIds = completeSupersededReplyEntryIds(timelineEntries);
  const supersededFoldsByAnchorEntryId = deriveSupersededAttemptFolds(
    timelineEntries,
    failedRunIds,
    liveSubagentEntryIds,
    completeSupersededReplyIds,
  );
  const supersededWorkItemIds = new Set(
    [...supersededFoldsByAnchorEntryId.values()].flatMap((fold) => fold.deferredWorkItemIds),
  );
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries: timelineEntries,
    unsettledRunId,
    isWorking: input.isWorking,
  });
  const runlessWorkActive = input.isWorking && input.runlessWorkActive === true;
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: timelineEntries,
    terminalAssistantMessageIds,
    latestRun: input.latestRun ?? null,
    unfoldedRunIds: activeVisualResponseRunIds,
    failedRunIds,
    runlessWorkActive,
    turnDiffSummaries: input.turnDiffSummaries,
    liveSubagentEntryIds,
    completeSupersededReplyEntryIds: completeSupersededReplyIds,
  });
  const timelineEntryById = new Map(timelineEntries.map((entry) => [entry.id, entry]));
  const turnFoldExpanded = (fold: TurnFold) =>
    (input.expandedRunIds?.has(fold.runId) ?? false) !== turnFoldStartsOpen(fold.ending);
  const collapsedEntryIds = new Set<string>();
  const collapsedFoldMemberIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    for (const entryId of turnFoldExpanded(fold) ? fold.endingEntryIds : fold.hiddenEntryIds) {
      collapsedEntryIds.add(entryId);
    }
    if (!turnFoldExpanded(fold)) {
      for (const entryId of fold.entryIds) {
        collapsedFoldMemberIds.add(entryId);
      }
    }
  }
  const collapsedSupersededEntryIds = new Set<string>();
  for (const fold of supersededFoldsByAnchorEntryId.values()) {
    if (!input.expandedAttemptIds?.has(fold.attemptId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedSupersededEntryIds.add(entryId);
      }
    }
  }
  if (input.pendingApprovalRequestIds?.size) {
    for (const entry of timelineEntries) {
      if (entry.kind === "work" && isPendingApproval(entry.entry)) {
        collapsedEntryIds.delete(entry.id);
        collapsedSupersededEntryIds.delete(entry.id);
      }
    }
  }
  const runIdIsActiveResponse = (runId: RunId | null | undefined) =>
    runId == null ? runlessWorkActive : activeVisualResponseRunIds.has(runId);
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    input.isWorking &&
    entry.toolLifecycleStatus === "inProgress" &&
    (entry.runId == null ? runlessWorkActive : entry.runId === unsettledRunId);

  const activeTurnHeaderIndex = input.isWorking
    ? lastResponseBoundaryIndex(timelineEntries) + 1
    : timelineEntries.length;

  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  if (input.isWorking && (unsettledRunId !== null || runlessWorkActive)) {
    let tailAttemptId: string | null | undefined;
    for (let index = timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
      const entry = timelineEntries[index]!;
      if (
        entry.kind !== "work" ||
        entry.entry.tone === "error" ||
        entry.entry.sourceActivityKind === "runtime.error" ||
        entry.entry.itemType === "system_notice" ||
        entry.entry.itemType === "notification" ||
        entry.entry.questionAnswer !== undefined ||
        isPendingApproval(entry.entry) ||
        !runIdIsActiveResponse(entry.entry.runId) ||
        entry.entry.sourceActivityKind === "context-compaction" ||
        collapsedEntryIds.has(entry.id) ||
        collapsedSupersededEntryIds.has(entry.id) ||
        foldsByAnchorEntryId.has(entry.id) ||
        supersededFoldsByAnchorEntryId.has(entry.id)
      ) {
        break;
      }
      if (tailAttemptId === undefined) {
        tailAttemptId = entry.attempt?.id ?? null;
      } else if ((entry.attempt?.id ?? null) !== tailAttemptId) {
        break;
      }
      activeToolEntries.push(entry);
    }
  }
  activeToolEntries.reverse();
  const visibleActiveToolEntries = activeToolEntries.filter((entry) =>
    workEntryIsVisibleInGroup(entry.entry, true),
  );
  const activeWorkAnchor = activeToolEntries[0];
  const latestVisibleToolEntry = visibleActiveToolEntries.at(-1);
  const latestRunningToolEntry = visibleActiveToolEntries.findLast((entry) =>
    workEntryIsActiveTurnActivity(entry.entry),
  );
  const latestToolKeepsActivityLive =
    latestRunningToolEntry !== undefined ||
    (latestVisibleToolEntry !== undefined &&
      workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry) &&
      !input.pendingApprovalRequestIds?.size);
  const latestToolFailed =
    latestRunningToolEntry === undefined &&
    latestVisibleToolEntry !== undefined &&
    latestVisibleToolEntry.entry.toolLifecycleStatus !== "declined" &&
    workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry);

  const latestThoughtEntry = visibleActiveToolEntries.findLast(
    (entry) => entry.entry.itemType === "reasoning" && (entry.entry.detail?.trim() ?? "") !== "",
  );
  const activeWorkPlacementEntryId = latestVisibleToolEntry?.id;
  const activeWorkRow =
    activeWorkAnchor && latestVisibleToolEntry && !latestToolFailed
      ? (() => {
          const groupId = workGroupId(activeWorkAnchor.id);
          return {
            kind: "work-live" as const,
            id: latestToolKeepsActivityLive
              ? LIVE_ACTIVITY_ROW_ID
              : `work-live:${activeWorkAnchor.id}`,
            createdAt: activeWorkAnchor.createdAt,
            entry: (latestRunningToolEntry ?? latestVisibleToolEntry).entry,
            groupedEntries: visibleActiveToolEntries.map((entry) => entry.entry),
            groupId,
            expanded: input.expandedWorkGroupIds?.has(groupId) ?? false,
            active: latestToolKeepsActivityLive,
            ...(latestThoughtEntry ? { thought: latestThoughtEntry.entry } : {}),
          };
        })()
      : null;
  const activeWorkEntryIds = new Set(
    activeWorkRow !== null || latestToolFailed ? activeToolEntries.map((entry) => entry.id) : [],
  );
  // A bare `/compact` turn is the compaction itself: one compaction row stands in for its prompt
  // and working indicator, from the moment the turn starts. Likewise an answered "compact before
  // continuing?" question folds into the compaction it asked for.
  const compactionRuns = new Map<RunId, OrchestrationV2IdleCompaction | undefined>();
  const compactedRunIds = new Set<RunId>();
  const pendingResumeCompactionAgeByRunId = new Map<RunId, string>();
  const resumeCompactionAgeByEntryId = new Map<string, string>();
  for (const entry of timelineEntries) {
    if (
      entry.kind === "message" &&
      entry.message.runId !== null &&
      isCompactionCommandMessage(entry.message)
    ) {
      const reason = idleCompactionOf(entry.message);
      if (reason !== undefined) compactionRuns.set(entry.message.runId, reason);
    } else if (entry.kind === "work" && entry.entry.runId) {
      if (timelineEntryIsCompaction(entry)) {
        compactedRunIds.add(entry.entry.runId);
        const age = pendingResumeCompactionAgeByRunId.get(entry.entry.runId);
        if (age !== undefined) {
          resumeCompactionAgeByEntryId.set(entry.id, age);
          pendingResumeCompactionAgeByRunId.delete(entry.entry.runId);
        }
      }
      const age = entry.entry.questionAnswer
        ? claudeResumeCompactionAge(entry.entry.questionAnswer)
        : null;
      if (age !== null) pendingResumeCompactionAgeByRunId.set(entry.entry.runId, age);
    }
  }
  const compactionTitle = (runId: RunId | null | undefined, entryId: string) => {
    if (runId == null) return undefined;
    const reason = compactionRuns.get(runId);
    if (reason !== undefined) return IDLE_COMPACTION_TITLES[reason];
    const age = resumeCompactionAgeByEntryId.get(entryId);
    return age ? `Context compacted after ${age} idle` : undefined;
  };
  const activeCompactionEntry = timelineEntries.find(
    (entry): entry is Extract<TimelineEntry, { kind: "work" }> =>
      timelineEntryIsCompaction(entry) &&
      entry.kind === "work" &&
      workEntryIsInActiveRun(entry.entry),
  );
  const activeRunIsCompaction =
    input.isWorking && unsettledRunId !== null && compactionRuns.has(unsettledRunId);
  // The item can finish before its run settles; only other work should keep activity visible.
  const compactionRunFinished =
    activeRunIsCompaction &&
    compactedRunIds.has(unsettledRunId) &&
    activeCompactionEntry === undefined;
  const compactionOnlyRunFinished =
    compactionRunFinished &&
    !timelineEntries.some(
      (entry) =>
        timelineEntryRunId(entry) === unsettledRunId &&
        !timelineEntryIsCompaction(entry) &&
        !(entry.kind === "message" && isCompactionCommandMessage(entry.message)),
    );
  const runningCompactionRunId =
    activeRunIsCompaction && !compactionRunFinished ? unsettledRunId : null;
  // Compacting on return holds back the message the user just sent, so the working row says why
  // it is waiting. Any other compaction shows only its live divider, never both.
  const compactsOnReturn =
    runningCompactionRunId !== null && compactionRuns.get(runningCompactionRunId) === "onReturn";
  // The question is answered mid-turn, so the row times this compaction, not the turn.
  const resumeCompactionEntry =
    activeCompactionEntry?.entry.runId != null &&
    resumeCompactionAgeByEntryId.has(activeCompactionEntry.id)
      ? activeCompactionEntry
      : undefined;
  const activeCompactionRunId = compactsOnReturn
    ? runningCompactionRunId
    : (resumeCompactionEntry?.entry.runId ?? null);
  const appendWorkingRow = () => {
    if (compactionOnlyRunFinished) return;
    if (runningCompactionRunId !== null && activeCompactionRunId === null) return;
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt:
        (compactsOnReturn ? undefined : resumeCompactionEntry?.entry.createdAt) ??
        input.activeTurnStartedAt ??
        null,
      ...(activeCompactionRunId !== null ? { compacting: true as const } : {}),
    });
  };
  let hasActivityRow = false;
  const hasActiveCompaction =
    activeCompactionEntry !== undefined || (activeRunIsCompaction && !compactionRunFinished);
  const appendActiveWorkRows = () => {
    if (activeWorkRow === null) return;
    nextRows.push(activeWorkRow);
    hasActivityRow ||= activeWorkRow.active;
    if (!activeWorkRow.expanded) return;
    nextRows.push(
      expandedWorkGroupRow(
        activeWorkRow.groupId,
        activeWorkRow.createdAt,
        activeWorkRow.groupedEntries,
      ),
    );
  };

  const timelineSlashCommand = (message: ChatMessage): TimelineSlashCommand | null => {
    const parsed = parseSlashCommandMessage(
      message.text,
      input.slashCommands ?? EMPTY_SLASH_COMMAND_CATALOG,
    );
    if (!parsed) return null;
    const standalone = parsed.standalone && (message.attachments?.length ?? 0) === 0;
    const runId = message.runId ?? null;
    const compaction =
      standalone && !parsed.skill && parsed.name === "compact" && runId !== null
        ? compactionByRunId.get(runId)
        : undefined;
    if (compaction) mergedCompactionIds.add(compaction.id);
    const compactionItem = compaction?.projectedItem?.item;
    const state: SlashCommandState =
      runId === null
        ? input.isWorking
          ? "running"
          : "done"
        : runId === unsettledRunId
          ? "running"
          : failedRunIds.has(runId)
            ? "failed"
            : stoppedRunIds.has(runId)
              ? "stopped"
              : "done";
    return {
      ...parsed,
      standalone,
      state,
      result:
        compactionItem?.type === "compaction" &&
        compactionItem.beforeTokenCount !== undefined &&
        compactionItem.afterTokenCount !== undefined
          ? `${formatTokens(compactionItem.beforeTokenCount)} → ${formatTokens(compactionItem.afterTokenCount)} tokens`
          : null,
    };
  };

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (input.isWorking && index === activeTurnHeaderIndex) {
      appendWorkingRow();
    }

    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      const deferredWorkItemIds = [...turnFold.entryIds].flatMap((entryId) => {
        const entry = timelineEntryById.get(entryId);
        return entry?.kind === "work" &&
          entry.entry.projectedItem?.item.deferredWork &&
          !supersededWorkItemIds.has(String(entry.entry.projectedItem.sourceItemId))
          ? [String(entry.entry.projectedItem.sourceItemId)]
          : [];
      });
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.runId}`,
        ...(deferredWorkItemIds.length > 0 ? { deferredWorkItemIds } : {}),
        createdAt: turnFold.createdAt,
        runId: turnFold.runId,
        label: turnFold.label,
        ending: turnFold.ending,
        diff: turnFold.diff,
        expanded: turnFoldExpanded(turnFold),
        foldable: [...turnFold.hiddenEntryIds].some(
          (entryId) => !turnFold.endingEntryIds.has(entryId),
        ),
        failureMessage: turnFold.failureMessage,
        noticeMessage: turnFold.noticeMessage,
      });
    }

    // A turn stopped before any work anchors its fold here, so it goes after it.
    if (
      collapsedEntryIds.has(timelineEntry.id) ||
      (timelineEntry.kind === "event" &&
        (timelineEntry.projectedItem.item.type === "run_interrupt_request" ||
          (timelineEntry.projectedItem.item.type === "run_interrupt_result" &&
            timelineEntry.projectedItem.item.runId !== null &&
            compactionRuns.has(timelineEntry.projectedItem.item.runId) &&
            compactedRunIds.has(timelineEntry.projectedItem.item.runId))))
    ) {
      continue;
    }

    const supersededFold = supersededFoldsByAnchorEntryId.get(timelineEntry.id);
    if (supersededFold) {
      nextRows.push({
        kind: "attempt-fold",
        deferredWorkItemIds: supersededFold.deferredWorkItemIds,
        id: `attempt-fold:${supersededFold.attemptId}`,
        createdAt: supersededFold.createdAt,
        runId: supersededFold.runId,
        attemptId: supersededFold.attemptId,
        label: "Superseded attempt",
        expanded: input.expandedAttemptIds?.has(supersededFold.attemptId) ?? false,
      });
    }

    if (collapsedSupersededEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (
      timelineEntry.kind === "work" &&
      timelineEntry.entry.sourceActivityKind === "context-compaction"
    ) {
      const active = workEntryIsInActiveRun(timelineEntry.entry);
      if (mergedCompactionIds.has(timelineEntry.id)) continue;
      if (
        active &&
        activeCompactionRunId !== null &&
        timelineEntry.entry.runId === activeCompactionRunId
      )
        continue;
      const compaction = timelineEntry.entry.structuredPayload;
      const compactionRunId = timelineEntry.entry.runId;
      const title = compactionTitle(compactionRunId, timelineEntry.id);
      const reason = compactionRunId == null ? undefined : compactionRuns.get(compactionRunId);
      const failed = compaction?.type === "compaction" && compaction.status === "failed";
      const failure = failed ? compaction.summary?.trim() || undefined : undefined;
      nextRows.push({
        kind: "context-compaction",
        id: timelineEntry.id,
        ...(title ? { title } : {}),
        ...(failed ? { failed: true } : {}),
        ...(failure ? { failure } : {}),
        createdAt: timelineEntry.createdAt,
        label: active && reason ? IDLE_COMPACTING_LABELS[reason] : timelineEntry.entry.label,
        tokenCounts:
          compaction?.type === "compaction" ? contextCompactionTokenCounts(compaction) : null,
        active,
      });
      continue;
    }

    if (
      timelineEntry.kind === "work" &&
      timelineEntry.entry.runId != null &&
      compactedRunIds.has(timelineEntry.entry.runId) &&
      timelineEntry.entry.questionAnswer !== undefined &&
      claudeResumeCompactionAge(timelineEntry.entry.questionAnswer) !== null
    ) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (
        isPendingApproval(timelineEntry.entry) ||
        (timelineEntry.entry.runId != null && itemizedRunIds.has(timelineEntry.entry.runId)) ||
        (timelineEntry.entry.itemType === "error" &&
          timelineEntry.entry.toolLifecycleStatus === "failed") ||
        timelineEntry.entry.tone === "error" ||
        timelineEntry.entry.sourceActivityKind === "runtime.error" ||
        timelineEntry.entry.itemType === "system_notice" ||
        timelineEntry.entry.itemType === "notification" ||
        timelineEntry.entry.questionAnswer !== undefined
      ) {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
          isExpandedToolGroup: false,
        });
        continue;
      }
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.sourceActivityKind === "context-compaction" ||
          (nextEntry.entry.itemType === "error" &&
            nextEntry.entry.toolLifecycleStatus === "failed") ||
          nextEntry.entry.tone === "error" ||
          nextEntry.entry.sourceActivityKind === "runtime.error" ||
          nextEntry.entry.itemType === "system_notice" ||
          nextEntry.entry.itemType === "notification" ||
          nextEntry.entry.questionAnswer !== undefined ||
          isPendingApproval(nextEntry.entry) ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          collapsedSupersededEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id) ||
          supersededFoldsByAnchorEntryId.has(nextEntry.id) ||
          (nextEntry.entry.runId ?? null) !== (timelineEntry.entry.runId ?? null) ||
          nextEntry.attempt?.id !== timelineEntry.attempt?.id
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter((entry) =>
        workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry)),
      );
      if (visibleGroupedEntries.length > 0) {
        const activeInProgressToolEntries = visibleGroupedEntries.filter(workEntryIsInActiveRun);
        if (activeInProgressToolEntries.length > 0) {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const latestActiveToolEntry = activeInProgressToolEntries.at(-1)!;
          nextRows.push({
            kind: "work-live",
            id: `work-live:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            entry: latestActiveToolEntry,
            groupedEntries: visibleGroupedEntries,
            groupId,
            expanded,
            active: true,
          });
          hasActivityRow = true;
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries),
            );
          }
        } else if (
          visibleGroupedEntries.length === 1 &&
          workLogEntryIsToolLike(visibleGroupedEntries[0]!)
        ) {
          const singleEntry = visibleGroupedEntries[0]!;
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
            isExpandedToolGroup: false,
            displayLabel:
              toolGroupAction(singleEntry) === "edit"
                ? summarizeToolGroup(visibleGroupedEntries).summary
                : singleToolCallLabel(singleEntry),
          });
        } else {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const summaryKind = toolGroupSummaryKind(visibleGroupedEntries);
          const primarySourceEntry = visibleGroupedEntries.find(
            (entry) => entry.toolSource !== undefined,
          );
          const primarySourceKey = primarySourceEntry?.toolSource?.key;
          const primarySourceIcon = primarySourceKey
            ? (visibleGroupedEntries.find(
                (entry) =>
                  entry.toolSource?.key === primarySourceKey && entry.toolIcon !== undefined,
              )?.toolIcon ?? primarySourceEntry?.toolSource?.icon)
            : undefined;
          const groupToolSurface =
            primarySourceEntry?.toolSurface ??
            visibleGroupedEntries.findLast((entry) => entry.toolSurface !== undefined)?.toolSurface;
          const groupToolIcon =
            primarySourceIcon ??
            visibleGroupedEntries.findLast((entry) => entry.toolIcon !== undefined)?.toolIcon;
          const latestToolEntry = visibleGroupedEntries.findLast(workLogEntryIsToolLike);
          const singleEntry =
            visibleGroupedEntries.length === 1 ? (visibleGroupedEntries[0] ?? null) : null;
          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            runId: timelineEntry.entry.runId ?? null,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            summary:
              singleEntry !== null && !workLogEntryIsToolLike(singleEntry)
                ? singleEntry.label
                : summarizeToolGroup(visibleGroupedEntries).summary,
            summaryKind,
            ...(groupToolSurface ? { toolSurface: groupToolSurface } : {}),
            ...(groupToolIcon ? { toolIcon: groupToolIcon } : {}),
            hasFailure:
              latestToolEntry !== undefined &&
              workEntryDisplayIndicatesToolFailure(latestToolEntry),
          });
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries),
            );
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "html-render") {
      nextRows.push({
        kind: "html-render",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        htmlRender: timelineEntry.htmlRender,
      });
      continue;
    }

    if (timelineEntry.kind === "mcp-app") {
      nextRows.push({
        kind: "mcp-app",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        sourceThreadId: timelineEntry.sourceThreadId,
        itemId: timelineEntry.itemId,
        revision: timelineEntry.revision,
        mcpApp: timelineEntry.mcpApp,
      });
      continue;
    }

    if (timelineEntry.kind === "event") {
      const previous = nextRows.at(-1);
      if (
        timelineEntry.projectedItem.item.type === "subagent" &&
        previous?.kind === "event" &&
        previous.projectedItem.item.type === "subagent" &&
        previous.projectedItem.item.runId === timelineEntry.projectedItem.item.runId &&
        previous.projectedItem.item.providerTurnId ===
          timelineEntry.projectedItem.item.providerTurnId
      ) {
        nextRows[nextRows.length - 1] = {
          ...previous,
          subagents: [
            ...(previous.subagents ?? [previous.projectedItem]),
            timelineEntry.projectedItem,
          ],
        };
        continue;
      }
      nextRows.push({
        kind: "event",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        projectedItem: timelineEntry.projectedItem,
      });
      continue;
    }

    const compactionRunId = timelineEntry.message.runId;
    const compactionRun =
      compactionRunId !== null &&
      isCompactionCommandMessage(timelineEntry.message) &&
      idleCompactionOf(timelineEntry.message) !== undefined;
    if (compactionRun) {
      if (!compactedRunIds.has(compactionRunId) && compactionRunId !== activeCompactionRunId) {
        const pending = compactionRunId === runningCompactionRunId;
        const reason = compactionRuns.get(compactionRunId);
        nextRows.push({
          kind: "context-compaction",
          id: `compaction:${compactionRunId}`,
          createdAt: timelineEntry.createdAt,
          label: pending
            ? reason
              ? IDLE_COMPACTING_LABELS[reason]
              : "Compacting context"
            : "Context compaction",
          tokenCounts: null,
          active: pending,
        });
      }
      continue;
    }

    const assistantResponseStillInProgress =
      timelineEntry.message.role === "assistant" &&
      runIdIsActiveResponse(timelineEntry.message.runId);

    const isTerminalAssistantMessage =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id);
    const showAssistantMeta = isTerminalAssistantMessage && !assistantResponseStillInProgress;

    const command =
      timelineEntry.message.role === "user" && !userMessageIsSteer(timelineEntry.message)
        ? timelineSlashCommand(timelineEntry.message)
        : null;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      ...(command ? { command } : {}),
      ...(timelineEntry.projectedItem === undefined
        ? {}
        : { projectedItem: timelineEntry.projectedItem }),
      showAssistantMeta,
      showAssistantTimestamp:
        isTerminalAssistantMessage &&
        assistantResponseStillInProgress &&
        !timelineEntry.message.streaming,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantResponseStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
      steerOffsetMs: steerOffsetMs(timelineEntry.message, steerOffsetStartByRunId),
    });
  }

  const setupHandedOff =
    input.worktreeSetup !== null &&
    input.worktreeSetup !== undefined &&
    worktreeSetupAgentStarted(input.worktreeSetup) &&
    input.latestRun?.startedAt != null;
  const setupOwnsWorkingSlot =
    !setupHandedOff &&
    (input.worktreeSetup?.phase === "running" || input.worktreeSetup?.phase === "done");
  if (input.worktreeSetup && (!setupHandedOff || input.worktreeSetup.phase !== "running")) {
    const setupRow = {
      kind: "worktree-setup",
      id: WORKTREE_SETUP_ROW_ID,
      createdAt: input.worktreeSetup.startedAt,
      snapshot: input.worktreeSetup,
      embedded: setupHandedOff,
    } as const;
    const firstUserRowIndex = nextRows.findIndex(
      (row) => row.kind === "message" && row.message.role === "user",
    );
    const workingRowIndex = setupOwnsWorkingSlot
      ? nextRows.findIndex((row) => row.kind === "working")
      : -1;
    if (workingRowIndex >= 0) {
      nextRows.splice(workingRowIndex + 1, 0, setupRow);
    } else {
      const insertAt = firstUserRowIndex >= 0 ? firstUserRowIndex + 1 : nextRows.length;
      nextRows.splice(
        insertAt,
        0,
        ...(setupOwnsWorkingSlot
          ? [
              {
                kind: "working",
                id: "working-indicator-row",
                createdAt: input.worktreeSetup.startedAt,
              } as const,
              setupRow,
            ]
          : [setupRow]),
      );
    }
  }

  const hasWorkingRow = nextRows.some((row) => row.kind === "working");
  if (input.isWorking && !hasWorkingRow && activeTurnHeaderIndex === timelineEntries.length) {
    appendWorkingRow();
  }
  if (
    input.isWorking &&
    input.latestRun?.turnEnded !== true &&
    !setupOwnsWorkingSlot &&
    !hasActiveCompaction &&
    !compactionOnlyRunFinished &&
    (latestToolFailed || (!hasActivityRow && !input.pendingApprovalRequestIds?.size))
  ) {
    const failedGroupAnchor = latestToolFailed ? activeWorkAnchor : undefined;
    if (failedGroupAnchor) {
      const groupId = workGroupId(failedGroupAnchor.id);
      const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
        groupId,
        expanded,
      });
      if (expanded) {
        nextRows.push(
          expandedWorkGroupRow(
            groupId,
            failedGroupAnchor.createdAt,
            visibleActiveToolEntries.map((entry) => entry.entry),
          ),
        );
      }
    } else {
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
      });
    }
  }

  const result = attachTrailingToolGroupsToAssistant(
    attachCreatedThreadSummaries(nextRows, timelineEntries, collapsedFoldMemberIds),
  );
  return result.map((row, index) => {
    const next = result[index + 1];
    if (timelineRowIsWorkLog(row) && timelineRowIsWorkLog(next)) {
      return { ...row, continuesWorkLog: true };
    }
    if (!timelineRowIsUserPrompt(row)) return row;
    const promptRow = timelineRowIsUserPrompt(next) ? { ...row, continuesPromptStack: true } : row;
    if (!timelineRowIsOwnUserMessage(promptRow)) return promptRow;
    const previous = result[index - 1];
    const groupedWithPrevious = timelineRowIsOwnUserMessage(previous);
    const groupedWithNext = timelineRowIsOwnUserMessage(next);
    const continuesSteer =
      timelineRowIsOwnUserMessage(previous) &&
      userMessageIsSteer(promptRow.message) &&
      userMessageIsSteer(previous.message);
    if (!groupedWithNext && !groupedWithPrevious && !continuesSteer) return promptRow;
    return { ...promptRow, groupedWithNext, groupedWithPrevious, continuesSteer };
  });
}

function timelineRowIsUserPrompt(row: MessagesTimelineRow | undefined): boolean {
  return (
    row !== undefined &&
    row.kind === "message" &&
    row.message.role === "user" &&
    !row.command?.standalone
  );
}

function timelineRowIsOwnUserMessage(
  row: MessagesTimelineRow | undefined,
): row is Extract<MessagesTimelineRow, { kind: "message" }> {
  return (
    row?.kind === "message" &&
    row.message.role === "user" &&
    !row.command?.standalone &&
    resolveUserMessagePresentation(row.message).attribution === null
  );
}

function userMessageIsSteer(message: ChatMessage): boolean {
  return message.inputIntent === "steer" || message.inputIntent === "promoted_queued_to_steer";
}

/**
 * Where each run's clock starts for steer offsets: the latest run's own start
 * when known, otherwise the prompt that opened the run.
 */
function deriveSteerOffsetStartByRunId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestRun: TimelineLatestRun | null,
): ReadonlyMap<RunId, number> {
  const starts = new Map<RunId, number>();
  for (const entry of timelineEntries) {
    if (entry.kind !== "message" || entry.message.role !== "user") continue;
    const runId = entry.message.runId;
    if (runId == null || starts.has(runId) || userMessageIsSteer(entry.message)) continue;
    const ms = Date.parse(entry.message.createdAt);
    if (Number.isFinite(ms)) starts.set(runId, ms);
  }
  if (latestRun?.startedAt) {
    const ms = Date.parse(latestRun.startedAt);
    if (Number.isFinite(ms)) starts.set(latestRun.runId, ms);
  }
  return starts;
}

function steerOffsetMs(
  message: ChatMessage,
  startByRunId: ReadonlyMap<RunId, number>,
): number | undefined {
  if (message.role !== "user" || !userMessageIsSteer(message) || message.runId == null) {
    return undefined;
  }
  const start = startByRunId.get(message.runId);
  const at = Date.parse(message.createdAt);
  if (start === undefined || !Number.isFinite(at) || at < start) return undefined;
  return at - start;
}

function timelineRowIsWorkLog(row: MessagesTimelineRow | undefined): boolean {
  return (
    row !== undefined &&
    (row.kind === "work" ||
      row.kind === "work-toggle" ||
      row.kind === "work-live" ||
      row.kind === "thinking")
  );
}

function attachCreatedThreadSummaries(
  rows: MessagesTimelineRow[],
  timelineEntries: ReadonlyArray<TimelineEntry>,
  collapsedFoldMemberIds: ReadonlySet<string>,
): MessagesTimelineRow[] {
  const terminalIndexes = new Map<RunId, number>();
  const createdByRun = new Map<RunId, Array<Extract<MessagesTimelineRow, { kind: "event" }>>>();
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      terminalIndexes.set(row.message.runId, index);
    }
  }
  for (const entry of timelineEntries) {
    const projectedItem =
      entry.kind === "work"
        ? entry.entry.projectedItem
        : entry.kind === "event"
          ? entry.projectedItem
          : undefined;
    if (projectedItem?.item.type === "thread_created" && projectedItem.item.runId) {
      const runId = projectedItem.item.runId;
      const entries = createdByRun.get(runId) ?? [];
      entries.push({ kind: "event", id: entry.id, createdAt: entry.createdAt, projectedItem });
      createdByRun.set(runId, entries);
    }
  }
  return rows.flatMap((row, index): MessagesTimelineRow[] => {
    if (row.kind === "event" && row.projectedItem.item.type === "thread_created") {
      const runId = row.projectedItem.item.runId;
      const terminalIndex = runId === null ? undefined : terminalIndexes.get(runId);
      if (
        terminalIndex !== undefined &&
        (collapsedFoldMemberIds.has(row.id) || index > terminalIndex)
      )
        return [];
    }
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      return [
        row,
        ...(createdByRun.get(row.message.runId) ?? []).map((entry) => ({
          ...entry,
          id: `summary:${entry.id}`,
          resourceSummary: true,
        })),
      ];
    }
    return [row];
  });
}

const WORKTREE_SETUP_ROW_ID = "worktree-setup-row";

export type MessagesTimelineRowsInput = Parameters<typeof deriveMessagesTimelineRows>[0];

export type WorkingWindowItem =
  | { readonly kind: "work"; readonly id: string; readonly entry: WorkLogEntry }
  | {
      readonly kind: "text";
      readonly id: string;
      readonly message: ChatMessage;
      readonly projectedItemId?: string;
    }
  | {
      readonly kind: "agents";
      readonly id: string;
      readonly row: Extract<MessagesTimelineRow, { kind: "event" }>;
    };

export interface WorkingWindow {
  /** Changes with each prompt or steer, which closes an open history. */
  readonly key: string;
  readonly items: ReadonlyArray<WorkingWindowItem>;
  readonly diff: DiffLineStat | null;
  /** The latest test command failed; the count comes from the runner summary. */
  readonly failedTests: { readonly count: number | null } | null;
  /** Attempt number while the provider retries a dropped stream. */
  readonly retryAttempt: number | null;
  /** Stop was requested and the provider has not let go yet. */
  readonly stopping: boolean;
  readonly historyOpen: boolean;
  /** A standalone /compact owns its progress row and clock. */
  readonly compactCommand?: boolean;
}

function sameWorkingWindowItem(a: WorkingWindowItem, b: WorkingWindowItem): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  switch (a.kind) {
    case "work":
      return Equal.equals(a.entry, (b as typeof a).entry);
    case "text":
      return (
        a.message === (b as typeof a).message &&
        a.projectedItemId === (b as typeof a).projectedItemId
      );
    case "agents":
      return isRowUnchanged(a.row, (b as typeof a).row);
  }
}

function sameDiffLineStat(a: DiffLineStat | null, b: DiffLineStat | null): boolean {
  return a === b || (a?.additions === b?.additions && a?.deletions === b?.deletions);
}

function sameWorkingWindow(a: WorkingWindow | undefined, b: WorkingWindow | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.key === b.key &&
    a.historyOpen === b.historyOpen &&
    a.stopping === b.stopping &&
    a.compactCommand === b.compactCommand &&
    a.retryAttempt === b.retryAttempt &&
    a.failedTests?.count === b.failedTests?.count &&
    (a.failedTests === null) === (b.failedTests === null) &&
    sameDiffLineStat(a.diff, b.diff) &&
    a.items.length === b.items.length &&
    a.items.every((item, index) => sameWorkingWindowItem(item, b.items[index]!))
  );
}

function workEntryCommandInput(entry: WorkLogEntry): string | null {
  const item = entry.projectedItem?.item;
  return item?.type === "command_execution" ? item.input : (entry.command ?? null);
}

function deriveFailedTests(items: ReadonlyArray<WorkingWindowItem>): WorkingWindow["failedTests"] {
  // The latest test run decides: a passing rerun clears the slot.
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== "work" || item.entry.itemType !== "command_execution") continue;
    const input = workEntryCommandInput(item.entry);
    if (input === null || !commandRunsTests(input)) continue;
    if (item.entry.toolLifecycleStatus === "inProgress") return null;
    if (!workEntryDisplayIndicatesToolFailure(item.entry)) return null;
    const turnItem = item.entry.projectedItem?.item;
    return {
      count: turnItem?.type === "command_execution" ? (turnItem.failedTestCount ?? null) : null,
    };
  }
  return null;
}

function deriveRetryAttempt(items: ReadonlyArray<WorkingWindowItem>): number | null {
  const last = items.findLast(
    (item) => item.kind === "work" && item.entry.projectedItem?.item.type === "error",
  );
  const turnItem = last?.kind === "work" ? last.entry.projectedItem?.item : undefined;
  return turnItem?.type === "error" && turnItem.retry !== undefined && turnItem.status === "running"
    ? turnItem.retry.attempt
    : null;
}

/** Row ids and work entry ids that a working window item replaces. */
function collectWindowIds(items: ReadonlyArray<WorkingWindowItem>) {
  const ids = new Set<string>();
  for (const item of items) {
    ids.add(item.id);
    if (item.kind === "work") ids.add(item.entry.id);
    if (item.kind === "agents") {
      for (const member of item.row.subagents ?? []) ids.add(member.item.id);
    }
  }
  return ids;
}

function rowIsReplacedByWindow(row: MessagesTimelineRow, ids: ReadonlySet<string>): boolean {
  switch (row.kind) {
    case "thinking":
      return true;
    case "work":
      return (
        row.groupedEntries.length > 0 && row.groupedEntries.every((entry) => ids.has(entry.id))
      );
    case "work-live":
      return ids.has(row.entry.id);
    case "work-toggle":
      return ids.has(row.id.slice("work-toggle:".length));
    case "context-compaction":
    case "event":
      return ids.has(row.id);
    case "message":
      return row.message.role === "assistant" && ids.has(row.id);
    case "assistant-meta":
      return ids.has(row.message.id);
    default:
      return false;
  }
}

/**
 * Moves the running turn's work under the working bar. Tool calls, commentary
 * and subagents become window items; steers move above the bar so the prompt
 * stack reads top to bottom. Everything else (plans, resource cards, notices)
 * keeps its row.
 */
export function applyWorkingWindow(
  rows: ReadonlyArray<MessagesTimelineRow>,
  input: Pick<
    MessagesTimelineRowsInput,
    | "timelineEntries"
    | "latestRun"
    | "runningRunId"
    | "isWorking"
    | "runlessWorkActive"
    | "pendingApprovalRequestIds"
  >,
  historyOpenKey: string | null = null,
): MessagesTimelineRow[] {
  const workingIndex = input.isWorking ? rows.findIndex((row) => row.kind === "working") : -1;
  if (workingIndex < 0) return rows as MessagesTimelineRow[];
  const entries = timelineRowEntries(input.timelineEntries);
  const workingRow = rows[workingIndex] as Extract<MessagesTimelineRow, { kind: "working" }>;
  const compactionRowIds = new Set(
    rows.filter((row) => row.kind === "context-compaction").map((row) => row.id),
  );
  const compactedRunIds = new Set(
    entries.flatMap((entry) =>
      timelineEntryIsCompaction(entry) ? [timelineEntryRunId(entry)] : [],
    ),
  );
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const runIds = deriveActiveVisualResponseRunIds({
    timelineEntries: entries,
    unsettledRunId,
    isWorking: true,
  });
  const boundaryIndex = lastResponseBoundaryIndex(entries);
  let key = entries[boundaryIndex]?.id ?? "working";
  const items: WorkingWindowItem[] = [];
  // A standalone `/compact` row already shows its run's compaction.
  const compactCommandRunIds = new Set(
    rows.flatMap((row) =>
      row.kind === "message" &&
      row.command?.standalone &&
      row.command.name === "compact" &&
      !row.command.skill
        ? [row.message.runId ?? null]
        : [],
    ),
  );
  let interruptRequested = false;
  let interruptSettled = false;
  for (let index = boundaryIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.kind === "message" && entry.message.role === "user") {
      key = entry.id;
      continue;
    }
    if (entry.attempt?.status === "superseded") continue;
    const runId =
      entry.kind === "event" ? entry.projectedItem.item.runId : timelineEntryRunId(entry);
    // A provider-native subagent thread's live work has no app run.
    if (runId === null ? input.runlessWorkActive !== true : !runIds.has(runId)) continue;
    if (entry.kind === "work") {
      const item = entry.entry.projectedItem?.item;
      if (
        (item?.type === "approval_request" &&
          input.pendingApprovalRequestIds?.has(item.requestId)) ||
        entry.entry.itemType === "notification" ||
        entry.entry.itemType === "system_notice" ||
        (entry.entry.sourceActivityKind === "context-compaction" &&
          (compactCommandRunIds.has(runId) ||
            compactionRowIds.has(entry.id) ||
            workingRow.compacting !== undefined)) ||
        (compactedRunIds.has(runId) &&
          entry.entry.questionAnswer !== undefined &&
          claudeResumeCompactionAge(entry.entry.questionAnswer) !== null) ||
        !workEntryIsVisibleInGroup(entry.entry, true)
      ) {
        continue;
      }
      items.push({ kind: "work", id: entry.id, entry: entry.entry });
    } else if (entry.kind === "message" && entry.message.role === "assistant") {
      items.push({
        kind: "text",
        id: entry.id,
        message: entry.message,
        ...(entry.projectedItem ? { projectedItemId: entry.projectedItem.item.id } : {}),
      });
    } else if (entry.kind === "event") {
      const turnItem = entry.projectedItem.item;
      if (turnItem.type === "run_interrupt_request") interruptRequested = true;
      if (turnItem.type === "run_interrupt_result") interruptSettled = true;
      if (turnItem.type !== "subagent") continue;
      const previous = items.at(-1);
      if (
        previous?.kind === "agents" &&
        previous.row.projectedItem.item.providerTurnId === turnItem.providerTurnId
      ) {
        items[items.length - 1] = {
          ...previous,
          row: {
            ...previous.row,
            subagents: [
              ...(previous.row.subagents ?? [previous.row.projectedItem]),
              entry.projectedItem,
            ],
          },
        };
        continue;
      }
      items.push({
        kind: "agents",
        id: entry.id,
        row: {
          kind: "event",
          id: entry.id,
          createdAt: entry.createdAt,
          projectedItem: entry.projectedItem,
          subagents: [entry.projectedItem],
        },
      });
    }
  }

  const ids = collectWindowIds(items);
  const before: MessagesTimelineRow[] = [];
  const after: MessagesTimelineRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (index <= workingIndex) continue;
    if (row.kind === "message" && row.message.role === "user") {
      before.push(row);
    } else if (!rowIsReplacedByWindow(row, ids)) {
      after.push(row);
    }
  }
  const window: WorkingWindow = {
    key,
    items,
    compactCommand: compactCommandRunIds.has(unsettledRunId),
    diff: sumFileChangeLineStat(
      items.flatMap((item) => (item.kind === "work" ? [item.entry] : [])),
    ),
    failedTests: deriveFailedTests(items),
    retryAttempt: deriveRetryAttempt(items),
    stopping: interruptRequested && !interruptSettled,
    historyOpen: historyOpenKey === key,
  };
  return [
    ...rows.slice(0, workingIndex),
    ...before,
    { ...workingRow, window },
    ...after.map((row) => (row.continuesWorkLog ? { ...row, continuesWorkLog: false } : row)),
  ];
}

/** `expanded` with every "Handled N updates" group that holds the run open. */
export function withRunGroupsOpen(
  expanded: ReadonlySet<string>,
  rows: ReadonlyArray<MessagesTimelineRow>,
  runId: RunId,
): ReadonlySet<string> {
  const closed = rows.flatMap((row) =>
    row.kind === "background-activity" && row.runIds.includes(runId) && !expanded.has(row.id)
      ? [row.id]
      : [],
  );
  return closed.length === 0 ? expanded : new Set([...expanded, ...closed]);
}

/** Fold persisted notification deliveries; ordinary prompts and actionable runs stay visible. */
export function applyBackgroundActivityGroups(
  rows: MessagesTimelineRow[],
  input: Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "latestRun" | "runningRunId" | "expandedWorkGroupIds"
  > & {
    hasPendingRequest: boolean;
    hasThreadError: boolean;
  },
  previousRows: ReadonlyArray<MessagesTimelineRow> = [],
): MessagesTimelineRow[] {
  const notifications = new Map<RunId, Set<string>>();
  const excluded = new Set<RunId>();
  const entryRuns = new Map<string, RunId>();
  for (const entry of input.timelineEntries) {
    const item =
      timelineEntryTurnItem(entry) ??
      (entry.kind === "work" ? entry.entry.structuredPayload : undefined);
    const runId =
      entry.kind === "message" ? entry.message.runId : (item?.runId ?? timelineEntryRunId(entry));
    if (runId == null) continue;
    entryRuns.set(entry.id, runId);
    if (item?.type === "notification") {
      const ids = notifications.get(runId) ?? new Set<string>();
      ids.add(item.id);
      notifications.set(runId, ids);
    }
    if (
      (entry.kind === "message" && entry.message.role === "user") ||
      entry.kind === "proposed-plan" ||
      item?.type === "error" ||
      item?.type === "system_notice" ||
      item?.status === "failed" ||
      (item?.type === "notification" && item.outcome === "failed") ||
      ((item?.type === "approval_request" || item?.type === "user_input_request") &&
        (item.status === "pending" || item.status === "running" || item.status === "waiting")) ||
      (entry.kind === "work" &&
        (entry.entry.tone === "error" || workEntryDisplayIndicatesToolFailure(entry.entry)))
    ) {
      excluded.add(runId);
    }
  }
  const activeRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const latestRunId = input.latestRun?.runId ?? activeRunId;
  if (
    latestRunId &&
    (input.hasPendingRequest || input.hasThreadError || input.latestRun?.status === "failed")
  ) {
    excluded.add(latestRunId);
  }
  for (const runId of excluded) notifications.delete(runId);
  if (notifications.size === 0) return rows;
  const previousGroupIds = new Map<RunId, string>();
  for (const row of previousRows) {
    if (row.kind !== "background-activity") continue;
    for (const runId of row.runIds) previousGroupIds.set(runId, row.id);
  }

  const rowRunId = (row: MessagesTimelineRow): RunId | null => {
    switch (row.kind) {
      case "message":
      case "assistant-meta":
        return row.message.runId ?? null;
      case "event":
        return row.projectedItem.item.runId;
      case "turn-fold":
      case "attempt-fold":
        return row.runId;
      case "work": {
        const runId = row.groupedEntries[0]?.runId;
        return runId && row.groupedEntries.every((entry) => entry.runId === runId) ? runId : null;
      }
      case "work-live":
        return row.entry.runId ?? null;
      case "working":
      case "thinking":
        return activeRunId;
      case "work-toggle":
        return row.runId ?? entryRuns.get(row.id.slice("work-toggle:".length)) ?? null;
      default:
        return entryRuns.get(row.id) ?? null;
    }
  };
  const result: MessagesTimelineRow[] = [];
  for (let index = 0; index < rows.length;) {
    const first = rows[index]!;
    const runId = rowRunId(first);
    // Start at the delivery itself, never at unrelated rows belonging to its run.
    if (runId === null || !notifications.get(runId)?.has(first.id)) {
      result.push(first);
      index += 1;
      continue;
    }
    const start = index;
    const runIds = new Set<RunId>();
    const updateIds = new Set<string>();
    while (index < rows.length) {
      const nextRow = rows[index]!;
      const nextRunId = rowRunId(nextRow);
      if (nextRunId === null || !notifications.has(nextRunId)) break;
      runIds.add(nextRunId);
      if (notifications.get(nextRunId)!.has(nextRow.id)) updateIds.add(nextRow.id);
      index += 1;
    }
    // Keep a mounted anchor across history prepends; restored open groups keep their key too.
    const expandedId = [...updateIds]
      .map((id) => `background-activity:${id}`)
      .find((id) => input.expandedWorkGroupIds?.has(id));
    const previousId = [...runIds]
      .map((id) => previousGroupIds.get(id))
      .find((id) => id !== undefined && updateIds.has(id.slice("background-activity:".length)));
    const id = expandedId ?? previousId ?? `background-activity:${first.id}`;
    const expanded = input.expandedWorkGroupIds?.has(id) ?? false;
    result.push({
      kind: "background-activity",
      id,
      createdAt: first.createdAt,
      runIds: [...runIds],
      updateCount: updateIds.size,
      active: activeRunId !== null && runIds.has(activeRunId),
      expanded,
    });
    // Expansion returns the original virtual rows, identities, disclosures and actions.
    if (expanded) result.push(...rows.slice(start, index));
  }
  return result;
}

interface MessagesTimelineRowsProjection {
  readonly input: MessagesTimelineRowsInput;
  readonly rows: MessagesTimelineRow[];
}

/**
 * Runless (imported V1) turns and work after a steer fold under synthetic
 * keys, so the entry's own run id is not enough to open them.
 */
export type TimelineTurnFoldKey = Pick<TurnFold, "runId" | "ending">;

/** Every folded entry's fold, computed once for callers that check many entries. */
export function timelineTurnFoldRunIdsByEntryId(
  input: Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "latestRun" | "isWorking" | "runlessWorkActive" | "runningRunId"
  >,
): ReadonlyMap<string, TimelineTurnFoldKey> {
  const byEntryId = new Map<string, TimelineTurnFoldKey>();
  for (const fold of deriveTimelineTurnFolds(input).values()) {
    const key = { runId: fold.runId, ending: fold.ending };
    for (const entryId of fold.hiddenEntryIds) {
      // Ending entries stay hidden at any fold state; the fold line carries them.
      if (!fold.endingEntryIds.has(entryId)) byEntryId.set(entryId, key);
    }
  }
  return byEntryId;
}

/**
 * A failed turn stays open by default: its fold names how it ended,
 * so its key in `expandedRunIds` means the user collapsed it.
 */
export function turnFoldStartsOpen(ending: TurnFoldEnding): boolean {
  return ending === "failed" || ending === "limited";
}

/** `expanded` with the fold open. */
export function withTurnFoldOpen(
  expanded: ReadonlySet<RunId>,
  fold: TimelineTurnFoldKey,
): ReadonlySet<RunId> {
  const startsOpen = turnFoldStartsOpen(fold.ending);
  if (expanded.has(fold.runId) !== startsOpen) return expanded;
  const next = new Set(expanded);
  if (startsOpen) next.delete(fold.runId);
  else next.add(fold.runId);
  return next;
}

function sameCheckpointSummaries(
  previous: MessagesTimelineRowsInput["turnDiffSummaries"],
  next: MessagesTimelineRowsInput["turnDiffSummaries"],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (const [index, summary] of previous.entries()) {
    if (!shallow(summary, next[index])) return false;
  }
  return true;
}

function replaceStreamingMessageRows(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection,
): MessagesTimelineRow[] | null {
  const {
    timelineEntries: previousEntries,
    latestRun: previousRun,
    turnDiffSummaries: previousCheckpoints,
    expandedRunIds: previousExpandedRuns,
    expandedAttemptIds: previousExpandedAttempts,
    expandedWorkGroupIds: previousExpandedGroups,
    pendingApprovalRequestIds: previousPendingApprovalRequestIds,
    availableRevertTurnCounts: previousAvailableRevertTurnCounts,
    ...previousContext
  } = previous.input;
  const {
    timelineEntries,
    latestRun,
    turnDiffSummaries,
    expandedRunIds,
    expandedAttemptIds,
    expandedWorkGroupIds,
    pendingApprovalRequestIds,
    availableRevertTurnCounts,
    ...context
  } = input;
  // Shell/checkpoint selectors rebuild summaries per event; compare contents.
  if (
    timelineEntries.length !== previousEntries.length ||
    !shallow(previousContext, context) ||
    !shallow(previousRun, latestRun) ||
    !shallow(previousExpandedRuns, expandedRunIds) ||
    !shallow(previousExpandedAttempts, expandedAttemptIds) ||
    !shallow(previousExpandedGroups, expandedWorkGroupIds) ||
    !shallow(previousPendingApprovalRequestIds, pendingApprovalRequestIds) ||
    !shallow(previousAvailableRevertTurnCounts, availableRevertTurnCounts) ||
    !sameCheckpointSummaries(previousCheckpoints, turnDiffSummaries)
  ) {
    return null;
  }
  const replacements = new Map<ChatMessage, Extract<TimelineEntry, { kind: "message" }>>();
  for (let index = 0; index < timelineEntries.length; index += 1) {
    const entry = timelineEntries[index]!;
    const previousEntry = previousEntries[index]!;
    if (entry === previousEntry) continue;
    if (
      entry.kind !== "message" ||
      previousEntry.kind !== "message" ||
      entry.id !== previousEntry.id ||
      entry.createdAt !== previousEntry.createdAt ||
      entry.attempt !== previousEntry.attempt
    ) {
      return null;
    }
    if (
      entry.projectedItem !== previousEntry.projectedItem &&
      (entry.projectedItem === undefined ||
        previousEntry.projectedItem === undefined ||
        !isStreamingTurnItemTextUpdate(previousEntry.projectedItem, entry.projectedItem))
    ) {
      return null;
    }
    if (
      entry.message === previousEntry.message &&
      entry.projectedItem === previousEntry.projectedItem
    )
      continue;
    if (!isStreamingMessageTextUpdate(previousEntry.message, entry.message)) return null;
    replacements.set(previousEntry.message, entry);
  }
  if (replacements.size === 0) return previous.rows;
  return previous.rows.map((row) => {
    if (row.kind !== "message" && row.kind !== "assistant-meta") return row;
    const entry = replacements.get(row.message);
    return entry
      ? {
          ...row,
          message: entry.message,
          ...(entry.projectedItem === undefined ? {} : { projectedItem: entry.projectedItem }),
        }
      : row;
  });
}

export function deriveMessagesTimelineRowsWithState(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection | null = null,
): MessagesTimelineRowsProjection {
  return {
    input,
    rows:
      (previous === null ? null : replaceStreamingMessageRows(input, previous)) ??
      deriveMessagesTimelineRows(input),
  };
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow =
      prevRow && isRowUnchanged(prevRow, row) ? prevRow : withPreviousWindowItems(row, prevRow);
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** A changed working window keeps its unchanged items, so their rows skip rendering. */
function withPreviousWindowItems(
  row: MessagesTimelineRow,
  prevRow: MessagesTimelineRow | undefined,
): MessagesTimelineRow {
  if (row.kind !== "working" || prevRow?.kind !== "working" || !row.window || !prevRow.window) {
    return row;
  }
  const previousItems = new Map(prevRow.window.items.map((item) => [item.id, item]));
  let reused = false;
  const items = row.window.items.map((item) => {
    const previousItem = previousItems.get(item.id);
    if (previousItem === undefined || !sameWorkingWindowItem(previousItem, item)) return item;
    reused = true;
    return previousItem;
  });
  return reused ? { ...row, window: { ...row.window, items } } : row;
}

function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  if (a.continuesPromptStack !== b.continuesPromptStack) return false;

  switch (a.kind) {
    case "background-activity": {
      const bg = b as typeof a;
      return (
        a.createdAt === bg.createdAt &&
        a.updateCount === bg.updateCount &&
        a.active === bg.active &&
        a.expanded === bg.expanded &&
        shallow(a.runIds, bg.runIds)
      );
    }
    case "working":
      return (
        a.createdAt === (b as typeof a).createdAt &&
        sameWorkingWindow(a.window, (b as typeof a).window) &&
        a.compacting === (b as typeof a).compacting
      );
    case "thinking": {
      const bt = b as typeof a;
      return a.createdAt === bt.createdAt && a.groupId === bt.groupId && a.expanded === bt.expanded;
    }
    case "worktree-setup":
      return a.snapshot === (b as typeof a).snapshot;

    case "assistant-meta": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.projectedItem === bm.projectedItem &&
        a.message === bm.message &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming
      );
    }

    case "turn-fold": {
      const bf = b as typeof a;
      return (
        a.createdAt === bf.createdAt &&
        a.label === bf.label &&
        a.ending === bf.ending &&
        sameDiffLineStat(a.diff, bf.diff) &&
        a.expanded === bf.expanded &&
        a.foldable === bf.foldable &&
        a.failureMessage === bf.failureMessage &&
        a.noticeMessage === bf.noticeMessage &&
        (a.deferredWorkItemIds ?? []).length === (bf.deferredWorkItemIds ?? []).length &&
        (a.deferredWorkItemIds ?? []).every((id, index) => id === bf.deferredWorkItemIds?.[index])
      );
    }

    case "attempt-fold": {
      const bf = b as typeof a;
      return (
        a.createdAt === bf.createdAt &&
        a.label === bf.label &&
        a.expanded === bf.expanded &&
        (a.deferredWorkItemIds ?? []).length === (bf.deferredWorkItemIds ?? []).length &&
        (a.deferredWorkItemIds ?? []).every((id, index) => id === bf.deferredWorkItemIds?.[index])
      );
    }

    case "context-compaction": {
      const bc = b as typeof a;
      return (
        a.createdAt === bc.createdAt &&
        a.label === bc.label &&
        a.active === bc.active &&
        a.title === bc.title &&
        a.failed === bc.failed &&
        a.failure === bc.failure
      );
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "html-render": {
      // Tool updates rebuild entries; preserve frames for unchanged pages.
      const bh = b as typeof a;
      return a.createdAt === bh.createdAt && htmlRenderReferencesEqual(a.htmlRender, bh.htmlRender);
    }

    case "mcp-app": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.revision === bm.revision &&
        mcpAppReferencesEqual(a.mcpApp, bm.mcpApp)
      );
    }

    case "event":
      return (
        a.projectedItem === (b as typeof a).projectedItem &&
        a.resourceSummary === (b as typeof a).resourceSummary &&
        Equal.equals(a.subagents, (b as typeof a).subagents)
      );

    case "work": {
      const bw = b as typeof a;
      return (
        a.isExpandedToolGroup === bw.isExpandedToolGroup &&
        a.displayLabel === bw.displayLabel &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-live": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.expanded === bw.expanded &&
        a.active === bw.active &&
        Equal.equals(a.entry, bw.entry) &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.runId === bw.runId &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.summary === bw.summary &&
        a.summaryKind === bw.summaryKind &&
        a.toolSurface === bw.toolSurface &&
        Equal.equals(a.toolIcon, bw.toolIcon) &&
        a.hasFailure === bw.hasFailure
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.projectedItem === bm.projectedItem &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantTimestamp === bm.showAssistantTimestamp &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount &&
        a.groupedWithNext === bm.groupedWithNext &&
        a.groupedWithPrevious === bm.groupedWithPrevious &&
        a.continuesSteer === bm.continuesSteer &&
        a.steerOffsetMs === bm.steerOffsetMs &&
        shallow(a.command, bm.command)
      );
    }
  }
}

/** The working bar's short name for a pending approval, like "Approve git push". */
export function pendingApprovalSlotLabel(approval: {
  readonly requestKind: string;
  readonly detail?: string | undefined;
  readonly appName?: string | undefined;
}): string {
  switch (approval.requestKind) {
    case "command": {
      const words = (approval.detail ?? "")
        .trim()
        .split(/\s+/u)
        .filter((word) => word.length > 0 && !/^[A-Z_][A-Z0-9_]*=/u.test(word))
        .slice(0, 2)
        .join(" ");
      return words ? `Approve ${words}` : "Approve command";
    }
    case "file-read":
      return "Approve file read";
    case "file-change":
      return "Approve file change";
    case "mcp-elicitation":
      return approval.appName ? `Approve ${approval.appName}` : "Approve app access";
    default:
      return "Approve permission";
  }
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)/g;

function visibleUserMessageText(text: string): string {
  const linkLabels = (segment: string) => segment.replace(MARKDOWN_LINK, "$1");
  let visible = "";
  let cursor = 0;
  for (const match of collectAssistantCitations(text)) {
    visible += linkLabels(text.slice(cursor, match.start)) + assistantCitationLabel(match.citation);
    cursor = match.end;
  }
  return visible + linkLabels(text.slice(cursor));
}

export function shouldCollapseUserMessage(text: string): boolean {
  const visible = visibleUserMessageText(text);
  if (visible.trim().length === 0) {
    return false;
  }

  return (
    visible.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    visible.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

export function handoffRunsSignature(runs: ReadonlyArray<HandoffTimelineRun>): string {
  return runs
    .map(
      (run) =>
        `${run.id}\0${run.providerInstanceId}\0${run.ordinal}\0${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
    )
    .join("\n");
}

// Expanded-id sets can be rebuilt during render; comparing them by content keeps
// the render-time state update in useIncrementalTimelineRows from repeating forever.
export function sameRowsInput(
  left: MessagesTimelineRowsInput,
  right: MessagesTimelineRowsInput,
): boolean {
  for (const key of Object.keys(right) as Array<keyof MessagesTimelineRowsInput>) {
    const previous = left[key];
    const next = right[key];
    if (Object.is(previous, next)) continue;
    if (previous instanceof Set && next instanceof Set && shallow(previous, next)) continue;
    return false;
  }
  return Object.keys(left).length === Object.keys(right).length;
}
