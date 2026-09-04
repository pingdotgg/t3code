import * as Equal from "effect/Equal";
import { shallow } from "zustand/vanilla/shallow";
import { renderCodexDirectivesForCopy } from "@t3tools/client-runtime/codex-markdown-directives";
import { commandProgramName } from "@t3tools/client-runtime/work-log/command-label";
import {
  liveActivityToolStatus,
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  type ToolGroupSummaryKind,
} from "@t3tools/client-runtime/work-log/presentation";
export {
  normalizeCompactToolLabel,
  summarizeToolGroup,
  toolGroupAction,
  workLogEntryIsLocalCodeSearch,
} from "@t3tools/client-runtime/work-log/presentation";
import {
  formatDuration,
  isStreamingMessageTextUpdate,
  isStreamingTurnItemTextUpdate,
  timelineEntryIsPersistentResourceCard,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type TurnPlanEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import {
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type RunAttemptId,
  type RunId,
} from "@t3tools/contracts";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/shell";
import {
  resolveT3McpToolPresentation,
  type T3McpToolPresentation,
} from "@t3tools/shared/t3McpToolPresentation";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";

function timelineEntryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.runId ?? null) : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.runId;
  }
  return entry.kind === "work" ? (entry.entry.runId ?? null) : null;
}

/** Whether the entry still represents live activity, not a settled result. */
function workEntryIsActiveTurnActivity(entry: WorkLogEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    (entry.toolLifecycleStatus === undefined &&
      (entry.sourceActivityKind === "task.progress" || workLogEntryIsToolLike(entry)))
  );
}

function singleToolCallLabel(entry: WorkLogEntry): string {
  const toolPresentation = resolveWorkEntryToolPresentation(entry, "completed");
  if (toolPresentation) return toolPresentation.displayName;
  const command = entry.command?.trim();
  if (command) return command;
  const heading = normalizeCompactToolLabel(entry.toolTitle || entry.label);
  return `${heading.charAt(0).toUpperCase()}${heading.slice(1)}`;
}

export function workEntryDisplayLabel(entry: WorkLogEntry, workspaceRoot: string | undefined) {
  const toolPresentation = resolveWorkEntryToolPresentation(entry);
  if (toolPresentation) return toolPresentation.displayName;
  if (entry.command) return entry.command;
  // v2 provider error items carry the retry progress in the label; the
  // failure message is the detail behind the expander.
  if (entry.detail && entry.itemType !== "error") return entry.detail;
  const [firstPath] = entry.changedFiles ?? [];
  if (firstPath) {
    const path = formatWorkspaceRelativePath(firstPath, workspaceRoot);
    return entry.changedFiles!.length === 1
      ? path
      : `${path} +${entry.changedFiles!.length - 1} more`;
  }
  const heading = normalizeCompactToolLabel(entry.toolTitle || entry.label);
  return `${heading.charAt(0).toUpperCase()}${heading.slice(1)}`;
}

export function liveWorkEntryLabel(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
  active: boolean,
) {
  const status = liveActivityToolStatus(entry.toolLifecycleStatus, active);
  const toolPresentation = resolveWorkEntryToolPresentation({
    ...entry,
    toolLifecycleStatus: status,
  });
  if (toolPresentation) return toolPresentation.displayName;
  const command = entry.command?.trim();
  if (command) {
    const verb =
      status === "inProgress"
        ? "Running"
        : status === "failed"
          ? "Failed"
          : status === "declined"
            ? "Declined"
            : status === "stopped"
              ? "Stopped"
              : "Ran";
    return `${verb} ${commandProgramName(command) ?? "command"}`;
  }
  return workEntryDisplayLabel(entry, workspaceRoot);
}

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean {
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface WorkGroupScrollAnchor {
  readonly entryId: string;
  readonly offset: number;
}

/** Restore a visible tool, including a position partway through its expanded output. */
export function resolveWorkGroupScrollIndex(
  entries: ReadonlyArray<{ readonly id: string }>,
  anchor: WorkGroupScrollAnchor | undefined,
): { index: number; viewOffset: number } | undefined {
  if (!anchor) return undefined;
  const index = entries.findIndex((entry) => entry.id === anchor.entryId);
  return index < 0 ? undefined : { index, viewOffset: -anchor.offset };
}

/** Only newly appended calls may follow the end, never status or output updates. */
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

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * The follow re-arm band (#5566): strict isAtEnd flickers false for a frame
 * while streaming content grows under the viewport, so follow re-arms within
 * this distance of the real content bottom instead.
 */
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  if (!state) {
    return undefined;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // contentLength includes the composer inset spacer, but the composer hides
  // the same amount of viewport, so the inset cancels: plain
  // contentLength - scroll - scrollLength is the gap between the last real row
  // and the visible edge above the composer. LegendList's own isAtEnd subtracts
  // the inset and is true anywhere in the bottom composer-height band, so it is
  // only a fallback here, never a short-circuit.
  return contentLength - scroll - scrollLength <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
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

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
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

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestRun = Pick<
  ThreadRunSummary,
  "runId" | "status" | "startedAt" | "completedAt"
>;

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

export type MessagesTimelineRow =
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
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
    }
  | {
      kind: "thinking";
      id: string;
      createdAt: string | null;
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
      summaryToolIcon?: "browser" | "t3-code";
      hasFailure: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      runId: RunId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "attempt-fold";
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
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
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
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "turn-plan";
      id: string;
      createdAt: string;
      turnPlan: TurnPlanEntry;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

function workGroupId(timelineEntryId: string): string {
  return `work-group:${timelineEntryId}`;
}

export type TimelineToolPresentation = T3McpToolPresentation;
export const resolveTimelineToolPresentation = resolveT3McpToolPresentation;

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

interface TurnFold {
  runId: RunId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

interface SupersededAttemptFold {
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly anchorEntryId: string;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
}

/**
 * Groups only provider output owned by an explicitly superseded V2 attempt.
 * User messages remain visible because they are inputs to the logical run,
 * including the steer message that started the replacement attempt.
 */
function deriveSupersededAttemptFolds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): ReadonlyMap<string, SupersededAttemptFold> {
  const entriesByAttemptId = new Map<RunAttemptId, TimelineEntry[]>();
  for (const entry of timelineEntries) {
    if (
      entry.attempt?.status !== "superseded" ||
      (entry.kind === "message" && entry.message.role === "user") ||
      timelineEntryIsPersistentResourceCard(entry)
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
      runId: attempt.runId,
      attemptId: attempt.id,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds: new Set(entries.map((entry) => entry.id)),
    });
  }
  return foldsByAnchorEntryId;
}

/**
 * The latest turn counts as unsettled while it is still running (or has not
 * recorded a completion). This is deliberately keyed on the turn's own
 * lifecycle rather than transient working state: right after the user sends
 * a message, the previous turn is still the "active" one until the server
 * creates the new turn, and folding must not flicker through that window.
 */
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

function timelineEntryFoldRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message" && entry.message.role === "assistant") {
    return entry.message.runId ?? null;
  }
  if (entry.kind === "work") {
    return entry.entry.runId ?? null;
  }
  if (entry.kind === "turn-plan") {
    return entry.turnPlan.runId;
  }
  if (entry.kind === "event" && timelineEntryIsPersistentResourceCard(entry)) {
    return entry.projectedItem.item.runId;
  }
  return null;
}

/**
 * A promptless provider restart replaces the native turn without adding a
 * user message. Keep every provider turn since the latest user message in one
 * visual response until the replacement turn settles. A steer has its own
 * user message, so it naturally starts a new visual response.
 */
function lastUserMessageIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(
    (entry) => entry.kind === "message" && entry.message.role === "user",
  );
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

  const latestUserMessageIndex = lastUserMessageIndex(input.timelineEntries);
  for (let index = latestUserMessageIndex + 1; index < input.timelineEntries.length; index += 1) {
    const runId = timelineEntryRunId(input.timelineEntries[index]!);
    if (runId !== null) {
      runIds.add(runId);
    }
  }
  return runIds;
}

/**
 * Settled turns fold activity before their terminal assistant message behind
 * a "Worked for ..." row. Work that lands after that message stays visible so
 * failed or interrupted turns do not hide their trailing tool-call summary.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestRun: TimelineLatestRun | null;
  unfoldedRunIds: ReadonlySet<RunId>;
}): ReadonlyMap<string, TurnFold> {
  const interruptedRunIds = new Set<RunId>();
  for (const entry of input.timelineEntries) {
    if (
      entry.kind === "event" &&
      entry.projectedItem.item.runId !== null &&
      (entry.projectedItem.item.type === "run_interrupt_request" ||
        entry.projectedItem.item.type === "run_interrupt_result")
    ) {
      interruptedRunIds.add(entry.projectedItem.item.runId);
    }
  }

  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groupsByRunId = new Map<RunId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const runId = timelineEntryFoldRunId(entry);
    if (!runId) {
      continue;
    }
    let group = groupsByRunId.get(runId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
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

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [runId, group] of groupsByRunId) {
    if (input.unfoldedRunIds.has(runId) || interruptedRunIds.has(runId)) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    const terminalEntryIndex = group.terminalEntry
      ? group.entries.findIndex((entry) => entry.id === group.terminalEntry?.id)
      : group.entries.length;
    for (const [index, entry] of group.entries.entries()) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      const isCompaction =
        entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction";
      if (!isCompaction && index > terminalEntryIndex) {
        continue;
      }
      // Linked resources can outlive their launching run and stay visible
      // after the surrounding work folds.
      if (timelineEntryIsPersistentResourceCard(entry)) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }
    // A lone compaction row stays visible on its own; it only folds away as
    // part of a turn that already folds other work.
    const hidesNonCompactionWork = group.entries.some(
      (entry) =>
        hiddenEntryIds.has(entry.id) &&
        !(entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction"),
    );
    if (!hidesNonCompactionWork) {
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
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestRun?.runId === runId && input.latestRun.startedAt && input.latestRun.completedAt
        ? computeElapsedMs(input.latestRun.startedAt, input.latestRun.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(firstEntry.id, {
      runId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
}

/**
 * When a settled turn ends with tool calls after its terminal text, treat the
 * text and tools as one visual response. The message metadata becomes the
 * footer for the whole block instead of separating the prose from the tools.
 */
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
        candidate.kind === "work" &&
        candidate.groupedEntries.some((entry) => entry.runId === runId)
      ) {
        if (
          !candidate.isExpandedToolGroup &&
          candidate.groupedEntries.some(workLogEntryIsToolLike)
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

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun?: TimelineLatestRun | null;
  runningRunId?: RunId | null;
  expandedRunIds?: ReadonlySet<RunId>;
  expandedAttemptIds?: ReadonlySet<RunAttemptId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt?: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const supersededFoldsByAnchorEntryId = deriveSupersededAttemptFolds(input.timelineEntries);
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries: input.timelineEntries,
    unsettledRunId,
    isWorking: input.isWorking,
  });
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    terminalAssistantMessageIds,
    latestRun: input.latestRun ?? null,
    unfoldedRunIds: activeVisualResponseRunIds,
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedRunIds?.has(fold.runId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
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
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    input.isWorking &&
    unsettledRunId !== null &&
    entry.toolLifecycleStatus === "inProgress" &&
    entry.runId === unsettledRunId;

  // The active run's header row ("Working for ...") anchors right after the
  // latest user message, or at the run's first owned work entry when one
  // already rendered above it.
  let activeTurnHeaderIndex = input.timelineEntries.length;
  if (input.isWorking) {
    const latestUserMessageIndex = lastUserMessageIndex(input.timelineEntries);
    activeTurnHeaderIndex = latestUserMessageIndex + 1;
  }

  // Contiguous trailing work entries of the active run collapse into one live
  // row that survives between actions: while a tool runs it shows that tool,
  // and once everything settles it keeps the latest tool in past tense
  // instead of vanishing (#8984).
  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  if (input.isWorking && unsettledRunId !== null) {
    let tailAttemptId: string | null | undefined;
    for (let index = input.timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
      const entry = input.timelineEntries[index]!;
      if (
        entry.kind !== "work" ||
        entry.entry.tone === "error" ||
        entry.entry.runId == null ||
        !activeVisualResponseRunIds.has(entry.entry.runId) ||
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
      activeToolEntries.unshift(entry);
    }
  }
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
      workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry));
  const latestToolFailed =
    latestRunningToolEntry === undefined &&
    latestVisibleToolEntry !== undefined &&
    latestVisibleToolEntry.entry.toolLifecycleStatus !== "declined" &&
    workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry);
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
          };
        })()
      : null;
  const activeWorkEntryIds = new Set(
    activeWorkRow !== null || latestToolFailed ? activeToolEntries.map((entry) => entry.id) : [],
  );
  const appendWorkingRow = () => {
    const latestUserMessage = input.timelineEntries[lastUserMessageIndex(input.timelineEntries)];
    const visualResponseStartedAt =
      activeVisualResponseRunIds.size > 1 &&
      latestUserMessage?.kind === "message" &&
      latestUserMessage.message.role === "user"
        ? latestUserMessage.message.createdAt
        : input.activeTurnStartedAt;
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: visualResponseStartedAt ?? null,
    });
  };
  let hasActivityRow = false;
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

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (input.isWorking && index === activeTurnHeaderIndex) {
      appendWorkingRow();
    }

    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    // The terminal interrupt result is the useful timeline marker. The
    // preceding request is transient bookkeeping and duplicates that marker.
    if (
      timelineEntry.kind === "event" &&
      timelineEntry.projectedItem.item.type === "run_interrupt_request"
    ) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.runId}`,
        createdAt: turnFold.createdAt,
        runId: turnFold.runId,
        label: turnFold.label,
        expanded: input.expandedRunIds?.has(turnFold.runId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    const supersededFold = supersededFoldsByAnchorEntryId.get(timelineEntry.id);
    if (supersededFold) {
      nextRows.push({
        kind: "attempt-fold",
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
      nextRows.push({
        kind: "context-compaction",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        label: timelineEntry.entry.label,
      });
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (timelineEntry.entry.tone === "error") {
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
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.sourceActivityKind === "context-compaction" ||
          nextEntry.entry.tone === "error" ||
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
          const usesSingleToolCallLabel =
            singleEntry !== null &&
            workLogEntryIsToolLike(singleEntry) &&
            toolGroupAction(singleEntry) !== "edit";
          const summaryToolIcon = usesSingleToolCallLabel
            ? resolveWorkEntryToolPresentation(singleEntry, "completed")?.icon
            : undefined;
          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            runId: timelineEntry.entry.runId ?? null,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            summary: usesSingleToolCallLabel
              ? singleToolCallLabel(singleEntry)
              : singleEntry !== null && !workLogEntryIsToolLike(singleEntry)
                ? singleEntry.label
                : summarizeToolGroup(visibleGroupedEntries).summary,
            summaryKind,
            ...(groupToolSurface ? { toolSurface: groupToolSurface } : {}),
            ...(groupToolIcon ? { toolIcon: groupToolIcon } : {}),
            ...(summaryToolIcon ? { summaryToolIcon } : {}),
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

    if (timelineEntry.kind === "turn-plan") {
      nextRows.push({
        kind: "turn-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        turnPlan: timelineEntry.turnPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "event") {
      nextRows.push({
        kind: "event",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        projectedItem: timelineEntry.projectedItem,
      });
      continue;
    }

    const assistantResponseStillInProgress =
      timelineEntry.message.role === "assistant" &&
      timelineEntry.message.runId !== null &&
      timelineEntry.message.runId !== undefined &&
      activeVisualResponseRunIds.has(timelineEntry.message.runId);

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantResponseStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      ...(timelineEntry.projectedItem === undefined
        ? {}
        : { projectedItem: timelineEntry.projectedItem }),
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantResponseStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking && activeTurnHeaderIndex === input.timelineEntries.length) {
    appendWorkingRow();
  }
  if (input.isWorking && (!hasActivityRow || latestToolFailed)) {
    nextRows.push({
      kind: "thinking",
      id: LIVE_ACTIVITY_ROW_ID,
      createdAt: input.activeTurnStartedAt ?? null,
    });
  }

  return attachTrailingToolGroupsToAssistant(nextRows);
}

type MessagesTimelineRowsInput = Parameters<typeof deriveMessagesTimelineRows>[0];

export interface MessagesTimelineRowsProjection {
  readonly input: MessagesTimelineRowsInput;
  readonly rows: MessagesTimelineRow[];
}

function sameCheckpointSummaries(
  previous: MessagesTimelineRowsInput["turnDiffSummaryByAssistantMessageId"],
  next: MessagesTimelineRowsInput["turnDiffSummaryByAssistantMessageId"],
): boolean {
  if (previous === next) return true;
  if (previous.size !== next.size) return false;
  for (const [id, summary] of previous) {
    if (!shallow(summary, next.get(id))) return false;
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
    turnDiffSummaryByAssistantMessageId: previousCheckpoints,
    revertTurnCountByUserMessageId: previousReverts,
    ...previousContext
  } = previous.input;
  const {
    timelineEntries,
    latestRun,
    turnDiffSummaryByAssistantMessageId,
    revertTurnCountByUserMessageId,
    ...context
  } = input;
  // V2 shell and checkpoint selectors produce fresh summaries for each event.
  // Equivalent summaries must not invalidate a text-only projection.
  if (
    timelineEntries.length !== previousEntries.length ||
    !shallow(previousContext, context) ||
    !shallow(previousRun, latestRun) ||
    !shallow(previousReverts, revertTurnCountByUserMessageId) ||
    !sameCheckpointSummaries(previousCheckpoints, turnDiffSummaryByAssistantMessageId)
  ) {
    return null;
  }
  const replacements = new Map<ChatMessage, Extract<TimelineEntry, { kind: "message" }>>();
  for (const [index, entry] of timelineEntries.entries()) {
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

/** Keep one projection per timeline. Reuse rows only when streaming content changes. */
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
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
    case "thinking":
      return a.createdAt === (b as typeof a).createdAt;

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
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "attempt-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "context-compaction": {
      const bc = b as typeof a;
      return a.createdAt === bc.createdAt && a.label === bc.label;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "turn-plan": {
      const bp = b as typeof a;
      // Plans rewrite in place: compare step snapshots so an unchanged plan
      // keeps its row reference (virtualization stability).
      const aSteps = a.turnPlan.plan.steps;
      const bSteps = bp.turnPlan.plan.steps;
      return (
        a.createdAt === bp.createdAt &&
        aSteps.length === bSteps.length &&
        aSteps.every(
          (step, index) =>
            step.step === bSteps[index]!.step && step.status === bSteps[index]!.status,
        )
      );
    }

    case "event":
      return a.projectedItem === (b as typeof a).projectedItem;

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
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
