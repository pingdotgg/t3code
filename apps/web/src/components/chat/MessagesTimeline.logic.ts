import * as Equal from "effect/Equal";
import { renderCodexDirectivesForCopy } from "@t3tools/client-runtime/codex-markdown-directives";
import { commandProgramName } from "@t3tools/client-runtime/work-log/command-label";
import {
  liveActivityToolStatus,
  normalizeCompactToolLabel,
  omitSupersededLifecycleMarkers,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  appendToolGroupSummaryEntry,
  createToolGroupSummaryAccumulator,
  summarizeToolGroupAccumulator,
  toolGroupSummaryKindFromAccumulator,
  toolGroupAction,
  workEntryViewedImagePath,
  type ToolGroupSummaryAccumulator,
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
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@t3tools/contracts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";

export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

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
  if (entry.detail) return entry.detail;
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

/**
 * Rows that preview an image the agent viewed or produced. They stay out of
 * tool groups and out of the settled-turn fold: the image is the answer the
 * user asked for, not tool noise to hide behind "Worked for ...".
 */
function workEntryRendersImagePreview(entry: WorkLogEntry): boolean {
  return workEntryViewedImagePath(entry) !== null;
}

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean {
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    // An image row stands alone outside any group, so the neutral filter
    // would leave an empty gap while its tool is still in progress.
    workEntryRendersImagePreview(entry) ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}

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
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * Follow re-arm band above the hard bottom. Strict on purpose: LegendList's
 * isNearEnd fires within half a viewport, which re-armed live-follow while the
 * user was reading history and yanked them back down on the next stream chunk.
 * A small pixel band (instead of the 1px isAtEnd epsilon alone) keeps re-arming
 * reliable while streaming content is still growing under the viewport.
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

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
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
      kind: "work-toggle";
      id: string;
      createdAt: string;
      turnId?: TurnId | null;
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
      turnId: TurnId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "assistant-meta";
      id: string;
      createdAt: string;
      message: ChatMessage;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
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

function workGroupIdentity(timelineEntryId: string, entry: WorkLogEntry): string {
  return entry.toolCallId
    ? `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}`
    : timelineEntryId;
}

function workGroupId(timelineEntryId: string, entry: WorkLogEntry): string {
  return `work-group:${workGroupIdentity(timelineEntryId, entry)}`;
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

interface WorkGroupPresentationState {
  rawEntries: ReadonlyArray<WorkLogEntry>;
  activeTurnId: TurnId | null;
  visibleEntries: WorkLogEntry[];
  activeEntries: WorkLogEntry[];
  summary: ToolGroupSummaryAccumulator;
  latestToolEntry: WorkLogEntry | undefined;
  hasStatuslessLifecycleMarker: boolean;
}

const workGroupPresentationByAnchor = new WeakMap<WorkLogEntry, WorkGroupPresentationState>();

function isStatuslessLifecycleMarker(entry: WorkLogEntry): boolean {
  return (
    entry.toolCallId === undefined &&
    entry.toolLifecycleStatus === undefined &&
    (entry.sourceActivityKind === "tool.started" || entry.sourceActivityKind === "tool.updated")
  );
}

function isTerminalLifecycleEntry(entry: WorkLogEntry): boolean {
  return (
    entry.sourceActivityKind === "tool.completed" ||
    (entry.toolLifecycleStatus !== undefined && entry.toolLifecycleStatus !== "inProgress")
  );
}

function workEntryIsInActiveRunForTurn(entry: WorkLogEntry, activeTurnId: TurnId | null): boolean {
  return (
    activeTurnId !== null &&
    entry.toolLifecycleStatus === "inProgress" &&
    entry.turnId === activeTurnId
  );
}

function hasExactWorkGroupPrefix(
  previous: ReadonlyArray<WorkLogEntry>,
  next: ReadonlyArray<WorkLogEntry>,
): boolean {
  if (next.length < previous.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function buildWorkGroupPresentation(
  entries: ReadonlyArray<WorkLogEntry>,
  activeTurnId: TurnId | null,
): WorkGroupPresentationState {
  const visibleEntries = omitSupersededLifecycleMarkers(
    entries.filter((entry) =>
      workEntryIsVisibleInGroup(entry, workEntryIsInActiveRunForTurn(entry, activeTurnId)),
    ),
    (entry) => entry,
  );
  const state: WorkGroupPresentationState = {
    rawEntries: entries,
    activeTurnId,
    visibleEntries,
    activeEntries: [],
    summary: createToolGroupSummaryAccumulator(),
    latestToolEntry: undefined,
    hasStatuslessLifecycleMarker: entries.some(isStatuslessLifecycleMarker),
  };
  for (const entry of visibleEntries) {
    appendToolGroupSummaryEntry(state.summary, entry);
    if (workLogEntryIsToolLike(entry)) {
      state.latestToolEntry = entry;
    }
    if (workEntryIsInActiveRunForTurn(entry, activeTurnId)) {
      state.activeEntries.push(entry);
    }
  }
  return state;
}

function appendToWorkGroupPresentation(
  state: WorkGroupPresentationState,
  entries: ReadonlyArray<WorkLogEntry>,
): WorkGroupPresentationState | null {
  const startIndex = state.rawEntries.length;
  if (entries.length < startIndex) return null;
  if (!hasExactWorkGroupPrefix(state.rawEntries, entries)) {
    return null;
  }
  if (entries.length === startIndex) return state;

  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index]!;
    // A later terminal can hide an earlier id-less lifecycle marker. Rebuild
    // only this uncommon transition; ordinary completed tool calls append in
    // constant work after the initial group projection.
    if (state.hasStatuslessLifecycleMarker && isTerminalLifecycleEntry(entry)) {
      return null;
    }
    state.hasStatuslessLifecycleMarker ||= isStatuslessLifecycleMarker(entry);
    const active = workEntryIsInActiveRunForTurn(entry, state.activeTurnId);
    if (!workEntryIsVisibleInGroup(entry, active)) {
      continue;
    }
    state.visibleEntries.push(entry);
    appendToolGroupSummaryEntry(state.summary, entry);
    if (workLogEntryIsToolLike(entry)) {
      state.latestToolEntry = entry;
    }
    if (active) {
      state.activeEntries.push(entry);
    }
  }
  state.rawEntries = entries;
  return state;
}

function deriveWorkGroupPresentation(
  entries: ReadonlyArray<WorkLogEntry>,
  activeTurnId: TurnId | null,
): WorkGroupPresentationState {
  const anchor = entries[0];
  if (!anchor) {
    return buildWorkGroupPresentation(entries, activeTurnId);
  }
  const previous = workGroupPresentationByAnchor.get(anchor);
  if (previous?.activeTurnId === activeTurnId) {
    const next = appendToWorkGroupPresentation(previous, entries);
    if (next) return next;
  }
  const next = buildWorkGroupPresentation(entries, activeTurnId);
  workGroupPresentationByAnchor.set(anchor, next);
  return next;
}

type ActiveWorkTimelineEntry = Extract<TimelineEntry, { kind: "work" }>;

interface ActiveWorkPresentationState {
  rawEntries: ReadonlyArray<ActiveWorkTimelineEntry>;
  activeTurnId: TurnId | null;
  visibleEntries: ActiveWorkTimelineEntry[];
  latestRunningEntry: ActiveWorkTimelineEntry | undefined;
  hasStatuslessLifecycleMarker: boolean;
}

const activeWorkPresentationByAnchor = new WeakMap<WorkLogEntry, ActiveWorkPresentationState>();

export interface ActiveTimelineScanState {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  activeTurnId: TurnId | null;
  activeTurnHeaderIndex: number;
  activeToolEntries: ReadonlyArray<ActiveWorkTimelineEntry>;
}

export interface ActiveTimelineScanRef {
  current: ActiveTimelineScanState | null;
}

function hasExactActiveWorkPrefix(
  previous: ReadonlyArray<ActiveWorkTimelineEntry>,
  next: ReadonlyArray<ActiveWorkTimelineEntry>,
): boolean {
  if (next.length < previous.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function buildActiveWorkPresentation(
  entries: ReadonlyArray<ActiveWorkTimelineEntry>,
  activeTurnId: TurnId | null,
): ActiveWorkPresentationState {
  const visibleEntries = omitSupersededLifecycleMarkers(
    entries.filter((entry) => workEntryIsVisibleInGroup(entry.entry, true)),
    (entry) => entry.entry,
  );
  return {
    rawEntries: entries,
    activeTurnId,
    visibleEntries,
    latestRunningEntry: visibleEntries.findLast((entry) =>
      workEntryIsActiveTurnActivity(entry.entry),
    ),
    hasStatuslessLifecycleMarker: entries.some((entry) => isStatuslessLifecycleMarker(entry.entry)),
  };
}

function appendToActiveWorkPresentation(
  state: ActiveWorkPresentationState,
  entries: ReadonlyArray<ActiveWorkTimelineEntry>,
): ActiveWorkPresentationState | null {
  const startIndex = state.rawEntries.length;
  if (entries.length < startIndex) return null;
  if (!hasExactActiveWorkPrefix(state.rawEntries, entries)) return null;
  if (entries.length === startIndex) return state;

  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (state.hasStatuslessLifecycleMarker && isTerminalLifecycleEntry(entry.entry)) {
      return null;
    }
    state.hasStatuslessLifecycleMarker ||= isStatuslessLifecycleMarker(entry.entry);
    if (!workEntryIsVisibleInGroup(entry.entry, true)) continue;
    state.visibleEntries.push(entry);
    if (workEntryIsActiveTurnActivity(entry.entry)) {
      state.latestRunningEntry = entry;
    }
  }
  state.rawEntries = entries;
  return state;
}

function deriveActiveWorkPresentation(
  entries: ReadonlyArray<ActiveWorkTimelineEntry>,
  activeTurnId: TurnId | null,
): ActiveWorkPresentationState {
  const anchor = entries[0]?.entry;
  if (!anchor) return buildActiveWorkPresentation(entries, activeTurnId);
  const previous = activeWorkPresentationByAnchor.get(anchor);
  if (previous?.activeTurnId === activeTurnId) {
    const next = appendToActiveWorkPresentation(previous, entries);
    if (next) return next;
  }
  const next = buildActiveWorkPresentation(entries, activeTurnId);
  activeWorkPresentationByAnchor.set(anchor, next);
  return next;
}

function isActiveToolTimelineEntry(
  entry: TimelineEntry,
  index: number,
  activeTurnHeaderIndex: number,
  activeTurnId: TurnId | null,
): entry is ActiveWorkTimelineEntry {
  return (
    index >= activeTurnHeaderIndex &&
    (activeTurnId === null || timelineEntryTurnId(entry) === activeTurnId) &&
    entry.kind === "work" &&
    entry.entry.agentSpawn === undefined &&
    entry.entry.tone !== "error" &&
    !workEntryRendersImagePreview(entry.entry)
  );
}

function hasExactTimelinePrefix(
  previous: ReadonlyArray<TimelineEntry>,
  next: ReadonlyArray<TimelineEntry>,
): boolean {
  if (next.length < previous.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function deriveActiveToolTimelineEntries(
  input: {
    readonly timelineEntries: ReadonlyArray<TimelineEntry>;
    readonly isWorking: boolean;
  },
  unsettledTurnId: TurnId | null,
  activeTimelineScanRef: ActiveTimelineScanRef | undefined,
): { activeTurnHeaderIndex: number; activeToolEntries: ReadonlyArray<ActiveWorkTimelineEntry> } {
  if (!input.isWorking) {
    if (activeTimelineScanRef) {
      activeTimelineScanRef.current = null;
    }
    return { activeTurnHeaderIndex: input.timelineEntries.length, activeToolEntries: [] };
  }

  const previous = activeTimelineScanRef?.current;
  if (
    previous?.activeTurnId === unsettledTurnId &&
    hasExactTimelinePrefix(previous.timelineEntries, input.timelineEntries)
  ) {
    const appendedEntries: ActiveWorkTimelineEntry[] = [];
    let canAppend = true;
    for (
      let index = previous.timelineEntries.length;
      index < input.timelineEntries.length;
      index += 1
    ) {
      const entry = input.timelineEntries[index]!;
      if (
        !isActiveToolTimelineEntry(entry, index, previous.activeTurnHeaderIndex, unsettledTurnId)
      ) {
        canAppend = false;
        break;
      }
      appendedEntries.push(entry);
    }
    if (canAppend) {
      const activeToolEntries =
        appendedEntries.length > 0
          ? [...previous.activeToolEntries, ...appendedEntries]
          : previous.activeToolEntries;
      if (activeTimelineScanRef) {
        activeTimelineScanRef.current = {
          timelineEntries: input.timelineEntries,
          activeTurnId: unsettledTurnId,
          activeTurnHeaderIndex: previous.activeTurnHeaderIndex,
          activeToolEntries,
        };
      }
      return {
        activeTurnHeaderIndex: previous.activeTurnHeaderIndex,
        activeToolEntries,
      };
    }
  }

  const latestUserMessageIndex = lastUserMessageIndex(input.timelineEntries);
  const firstOwnedAfterUser =
    unsettledTurnId === null
      ? -1
      : input.timelineEntries.findIndex(
          (entry, index) =>
            index > latestUserMessageIndex && timelineEntryTurnId(entry) === unsettledTurnId,
        );
  const activeTurnHeaderIndex =
    firstOwnedAfterUser >= 0 ? firstOwnedAfterUser : latestUserMessageIndex + 1;
  const activeToolEntries: ActiveWorkTimelineEntry[] = [];
  for (let index = input.timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
    const entry = input.timelineEntries[index]!;
    if (!isActiveToolTimelineEntry(entry, index, activeTurnHeaderIndex, unsettledTurnId)) {
      break;
    }
    activeToolEntries.push(entry);
  }
  activeToolEntries.reverse();
  if (activeTimelineScanRef) {
    activeTimelineScanRef.current = {
      timelineEntries: input.timelineEntries,
      activeTurnId: unsettledTurnId,
      activeTurnHeaderIndex,
      activeToolEntries,
    };
  }
  return { activeTurnHeaderIndex, activeToolEntries };
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

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

function lastUserMessageIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(
    (entry) => entry.kind === "message" && entry.message.role === "user",
  );
}

function timelineEntryTurnId(entry: TimelineEntry): TurnId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.turnId ?? null) : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.turnId;
  }
  return entry.kind === "work" ? (entry.entry.turnId ?? null) : null;
}

function workEntryIsActiveTurnActivity(entry: WorkLogEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    (entry.toolLifecycleStatus === undefined &&
      (entry.sourceActivityKind === "task.progress" || workLogEntryIsToolLike(entry)))
  );
}

/**
 * Settled turns fold activity before their terminal assistant message behind
 * a "Worked for ..." row. Work that lands after that message stays visible so
 * failed or interrupted turns do not hide their trailing tool-call summary.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
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
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId =
      entry.kind === "message" && entry.message.role === "assistant"
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    if (turnId === input.unsettledTurnId) {
      // This group is never folded. Consume the pending user boundary just as
      // the old group allocation did, so a second turn after the same user
      // message still receives its own duration start.
      pendingUserBoundary = null;
      continue;
    }
    let group = groupsByTurnId.get(turnId);
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
      groupsByTurnId.set(turnId, group);
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
  for (const [turnId, group] of groupsByTurnId) {
    if (turnId === input.unsettledTurnId) {
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
      if (index > terminalEntryIndex) {
        continue;
      }
      // Agent-spawn CTA rows never fold: workflows outlive their launching
      // turn (dynamic spawns, background execution), and folding the CTA
      // when the turn settles makes a still-running fleet invisible.
      if (entry.kind === "work" && entry.entry.agentSpawn !== undefined) {
        continue;
      }
      if (entry.kind === "work" && workEntryRendersImagePreview(entry.entry)) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const firstHiddenEntry = group.entries.find((entry) => hiddenEntryIds.has(entry.id));
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !firstHiddenEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
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

    foldsByAnchorEntryId.set(firstHiddenEntry.id, {
      turnId,
      anchorEntryId: firstHiddenEntry.id,
      createdAt: firstHiddenEntry.createdAt,
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
    const turnId = row.kind === "message" ? (row.message.turnId ?? null) : null;
    if (
      row.kind !== "message" ||
      row.message.role !== "assistant" ||
      !row.showAssistantMeta ||
      turnId === null
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
      if (candidate.kind === "work-toggle" && candidate.turnId === turnId) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "work" &&
        candidate.groupedEntries.some((entry) => entry.turnId === turnId)
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
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  activeTimelineScanRef?: ActiveTimelineScanRef;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const activeRunTurnId = input.isWorking ? unsettledTurnId : null;
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds?.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }
  const { activeTurnHeaderIndex, activeToolEntries } = deriveActiveToolTimelineEntries(
    input,
    unsettledTurnId,
    input.activeTimelineScanRef,
  );
  const activeWorkPresentation = deriveActiveWorkPresentation(activeToolEntries, unsettledTurnId);
  const visibleActiveToolEntries = activeWorkPresentation.visibleEntries;
  const activeWorkAnchor = activeToolEntries[0];
  const latestVisibleToolEntry = visibleActiveToolEntries.at(-1);
  const latestRunningToolEntry = activeWorkPresentation.latestRunningEntry;
  const latestToolFailed =
    latestRunningToolEntry === undefined &&
    latestVisibleToolEntry !== undefined &&
    latestVisibleToolEntry.entry.toolLifecycleStatus !== "declined" &&
    workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry);
  const latestToolKeepsActivityLive =
    latestRunningToolEntry !== undefined ||
    (latestVisibleToolEntry !== undefined &&
      workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry));
  const activeWorkPlacementEntryId = latestVisibleToolEntry?.id;
  const activeWorkRow =
    activeWorkAnchor && latestVisibleToolEntry && !latestToolFailed
      ? (() => {
          const groupId = workGroupId(activeWorkAnchor.id, activeWorkAnchor.entry);
          return {
            kind: "work-live" as const,
            id: latestToolKeepsActivityLive
              ? LIVE_ACTIVITY_ROW_ID
              : `work-live:${workGroupIdentity(activeWorkAnchor.id, activeWorkAnchor.entry)}`,
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
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
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

    const anchoredTurnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (anchoredTurnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${anchoredTurnFold.turnId}`,
        createdAt: anchoredTurnFold.createdAt,
        turnId: anchoredTurnFold.turnId,
        label: anchoredTurnFold.label,
        expanded: input.expandedTurnIds?.has(anchoredTurnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (
        timelineEntry.entry.agentSpawn !== undefined ||
        timelineEntry.entry.tone === "error" ||
        workEntryRendersImagePreview(timelineEntry.entry)
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
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.agentSpawn !== undefined ||
          nextEntry.entry.tone === "error" ||
          workEntryRendersImagePreview(nextEntry.entry) ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const groupPresentation = deriveWorkGroupPresentation(groupedEntries, activeRunTurnId);
      const visibleGroupedEntries = groupPresentation.visibleEntries;
      if (visibleGroupedEntries.length > 0) {
        const activeInProgressToolEntries = groupPresentation.activeEntries;
        if (activeInProgressToolEntries.length > 0) {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const latestActiveToolEntry = activeInProgressToolEntries.at(-1)!;
          const groupedEntriesSnapshot = visibleGroupedEntries.slice();
          nextRows.push({
            kind: "work-live",
            id: `work-live:${workGroupIdentity(timelineEntry.id, timelineEntry.entry)}`,
            createdAt: timelineEntry.createdAt,
            entry: latestActiveToolEntry,
            groupedEntries: groupedEntriesSnapshot,
            groupId,
            expanded,
            active: true,
          });
          hasActivityRow = true;
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, groupedEntriesSnapshot),
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
            groupedEntries: visibleGroupedEntries.slice(),
            isExpandedToolGroup: false,
            displayLabel:
              toolGroupAction(singleEntry) === "edit"
                ? summarizeToolGroup(visibleGroupedEntries)
                : singleToolCallLabel(singleEntry),
          });
        } else {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const summaryKind = toolGroupSummaryKindFromAccumulator(groupPresentation.summary);
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
          const latestToolEntry = groupPresentation.latestToolEntry;
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
            turnId: timelineEntry.entry.turnId ?? null,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            summary: usesSingleToolCallLabel
              ? singleToolCallLabel(singleEntry)
              : singleEntry !== null && !workLogEntryIsToolLike(singleEntry)
                ? singleEntry.label
                : summarizeToolGroupAccumulator(groupPresentation.summary),
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
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries.slice()),
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

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
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
      createdAt: input.activeTurnStartedAt,
    });
  }

  return attachTrailingToolGroupsToAssistant(nextRows);
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
        a.message === bm.message &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming
      );
    }

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

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
        a.turnId === bw.turnId &&
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
