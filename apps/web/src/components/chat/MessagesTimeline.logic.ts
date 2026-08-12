import * as Equal from "effect/Equal";
import {
  formatDuration,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type TurnPlanEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@t3tools/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

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

export function resolveTimelineIsAtEnd(
  state: TimelineEndState | undefined,
  endInset = 0,
): boolean | undefined {
  if (!state) {
    return undefined;
  }
  if (state.isAtEnd) {
    return true;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // contentLength includes the end inset (composer overlay), so subtract it to
  // measure the distance to the real content bottom.
  return contentLength - scroll - scrollLength - endInset <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
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

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "work-live";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      active: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      onlyToolEntries: boolean;
      summary: string | null;
      summaryKind: ToolGroupAction | "mixed" | null;
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
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      showThinking: boolean;
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

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

type ToolGroupAction = "read" | "edit" | "command" | "search" | "other";

function toolGroupAction(entry: WorkLogEntry): ToolGroupAction {
  if (entry.requestKind === "file-read" || entry.itemType === "image_view") return "read";
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
  if (entry.itemType === "web_search") return "search";
  return "other";
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Edited ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "search":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
  }
}

/** Immediate, provider-neutral fallback while generated tool summaries are disabled or unavailable. */
export function summarizeToolGroup(entries: ReadonlyArray<WorkLogEntry>): string {
  const counts = new Map<ToolGroupAction, number>();
  for (const entry of entries) {
    const action = toolGroupAction(entry);
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  const labels = [...counts].map(([action, count]) => toolGroupActionLabel(action, count));
  return labels
    .map((label, index) => (index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)))
    .join(", ");
}

function toolGroupSummaryKind(entries: ReadonlyArray<WorkLogEntry>): ToolGroupAction | "mixed" {
  const actions = new Set(entries.map(toolGroupAction));
  return actions.size === 1 ? actions.values().next().value! : "mixed";
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
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
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

function timelineEntryTurnId(entry: TimelineEntry): TurnId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.turnId ?? null) : null;
  }
  if (entry.kind === "turn-plan") {
    return entry.turnPlan.turnId;
  }
  return entry.kind === "work" ? (entry.entry.turnId ?? null) : null;
}

/**
 * Settled turns fold their commentary and tool activity behind a
 * "Worked for ..." row anchored at the turn's first foldable entry; the
 * terminal assistant message stays visible below the fold.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    anchorEntry: TimelineEntry | null;
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
    const turnId = timelineEntryTurnId(entry);
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        anchorEntry: entry,
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    } else if (pendingUserBoundary !== null) {
      // The provider can keep the same turn id after a steering message. The
      // fold stays anchored where that turn originally began so the user
      // message keeps its chronological position in the timeline.
      pendingUserBoundary = null;
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
    for (const entry of group.entries) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      // Agent-spawn CTA rows never fold: workflows outlive their launching
      // turn (dynamic spawns, background execution), and folding the CTA
      // when the turn settles makes a still-running fleet invisible.
      if (entry.kind === "work" && entry.entry.agentSpawn !== undefined) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.anchorEntry ?? group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
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

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
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

  let activeTurnHeaderIndex = input.timelineEntries.length;
  if (input.isWorking) {
    const firstOwnedEntryIndex =
      unsettledTurnId === null
        ? -1
        : input.timelineEntries.findIndex(
            (entry) => timelineEntryTurnId(entry) === unsettledTurnId,
          );
    if (firstOwnedEntryIndex >= 0) {
      activeTurnHeaderIndex = firstOwnedEntryIndex;
    } else {
      const lastUserMessageIndex = input.timelineEntries.findLastIndex(
        (entry) => entry.kind === "message" && entry.message.role === "user",
      );
      activeTurnHeaderIndex = lastUserMessageIndex + 1;
    }
  }
  const entryBelongsToActiveTurn = (entry: TimelineEntry, index: number) =>
    input.isWorking &&
    (unsettledTurnId !== null
      ? timelineEntryTurnId(entry) === unsettledTurnId
      : index >= activeTurnHeaderIndex);
  const activeEntries = input.isWorking
    ? unsettledTurnId !== null
      ? input.timelineEntries.filter((entry) => timelineEntryTurnId(entry) === unsettledTurnId)
      : input.timelineEntries.slice(activeTurnHeaderIndex)
    : [];
  const activeTurnHasVisibleContent =
    activeEntries.some((entry) => {
      if (entry.kind === "message") {
        return entry.message.role === "assistant" && (entry.message.text?.trim().length ?? 0) > 0;
      }
      if (entry.kind === "work") {
        return (
          entry.entry.agentSpawn === undefined && !workEntryIndicatesToolNeutralStatus(entry.entry)
        );
      }
      if (entry.kind === "turn-plan") return true;
      return false;
    }) ||
    input.timelineEntries
      .slice(activeTurnHeaderIndex)
      .some((entry) => entry.kind === "proposed-plan" || entry.kind === "turn-plan");

  const activeAssistantEntryIds = new Set(
    input.timelineEntries.flatMap((entry, index) =>
      entryBelongsToActiveTurn(entry, index) &&
      entry.kind === "message" &&
      entry.message.role === "assistant"
        ? [entry.id]
        : [],
    ),
  );
  const activeWorkEntryIds = new Set<string>();
  const activeWorkRowsByAnchorId = new Map<
    string,
    Extract<MessagesTimelineRow, { kind: "work-live" }>
  >();

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const entry = input.timelineEntries[index];
    if (
      !entry ||
      entry.kind !== "work" ||
      entry.entry.agentSpawn !== undefined ||
      !entryBelongsToActiveTurn(entry, index)
    ) {
      continue;
    }
    activeWorkEntryIds.add(entry.id);
    if (workEntryIndicatesToolNeutralStatus(entry.entry) || !workLogEntryIsToolLike(entry.entry)) {
      continue;
    }

    const anchorEntry = entry;
    let latestToolEntry = entry;
    let cursor = index + 1;
    while (cursor < input.timelineEntries.length) {
      const nextEntry = input.timelineEntries[cursor];
      if (
        !nextEntry ||
        nextEntry.kind !== "work" ||
        nextEntry.entry.agentSpawn !== undefined ||
        !entryBelongsToActiveTurn(nextEntry, cursor)
      ) {
        break;
      }
      activeWorkEntryIds.add(nextEntry.id);
      if (
        !workEntryIndicatesToolNeutralStatus(nextEntry.entry) &&
        workLogEntryIsToolLike(nextEntry.entry)
      ) {
        latestToolEntry = nextEntry;
      }
      cursor += 1;
    }

    const hasNewerTurnContent = input.timelineEntries.slice(cursor).some((laterEntry, offset) => {
      const laterIndex = cursor + offset;
      if (laterEntry.kind === "message" && laterEntry.message.role === "user") {
        return true;
      }
      if (!entryBelongsToActiveTurn(laterEntry, laterIndex)) {
        return false;
      }
      if (laterEntry.kind === "message") {
        return laterEntry.message.role === "assistant";
      }
      if (laterEntry.kind === "turn-plan") {
        return true;
      }
      return (
        laterEntry.kind === "work" &&
        laterEntry.entry.agentSpawn === undefined &&
        !workEntryIndicatesToolNeutralStatus(laterEntry.entry) &&
        workLogEntryIsToolLike(laterEntry.entry)
      );
    });

    activeWorkRowsByAnchorId.set(anchorEntry.id, {
      kind: "work-live",
      id: `work-live:${anchorEntry.id}`,
      createdAt: anchorEntry.createdAt,
      entry: latestToolEntry.entry,
      active: !hasNewerTurnContent,
    });
    index = cursor - 1;
  }

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (input.isWorking && index === activeTurnHeaderIndex) {
      nextRows.push({
        kind: "working",
        id: "working-indicator-row",
        createdAt: input.activeTurnStartedAt,
        showThinking: !activeTurnHasVisibleContent,
      });
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.turnId}`,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        label: turnFold.label,
        expanded: input.expandedTurnIds?.has(turnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (activeAssistantEntryIds.has(timelineEntry.id) && timelineEntry.kind === "message") {
      nextRows.push({
        kind: "message",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        message: timelineEntry.message,
        durationStart:
          durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
        showAssistantMeta: false,
        showAssistantCopyButton: false,
        assistantCopyStreaming: true,
        assistantTurnDiffSummary: undefined,
        revertTurnCount: undefined,
      });
      continue;
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      const activeWorkRow = activeWorkRowsByAnchorId.get(timelineEntry.id);
      if (activeWorkRow) {
        nextRows.push(activeWorkRow);
      }
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter(
        (entry) => !workEntryIndicatesToolNeutralStatus(entry),
      );
      if (visibleGroupedEntries.length > 0) {
        const onlyToolEntries = visibleGroupedEntries.every(
          (entry) => workLogEntryIsToolLike(entry) && entry.agentSpawn === undefined,
        );
        if (onlyToolEntries) {
          const groupId = `work-group:${timelineEntry.id}`;
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            onlyToolEntries: true,
            summary: summarizeToolGroup(visibleGroupedEntries),
            summaryKind: toolGroupSummaryKind(visibleGroupedEntries),
            hasFailure: visibleGroupedEntries.some((entry) => workEntryIndicatesToolFailure(entry)),
          });
          if (expanded) {
            for (const workEntry of visibleGroupedEntries) {
              nextRows.push({
                kind: "work",
                id: workEntry.id,
                createdAt: workEntry.createdAt,
                groupedEntries: [workEntry],
              });
            }
          }
        } else if (visibleGroupedEntries.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
          });
        } else {
          const groupId = `work-group:${timelineEntry.id}`;
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          // Agent-spawn CTA rows are always visible: a running fleet must
          // never hide behind a "+N tool calls" toggle. Selection is by
          // membership (spawn OR recent-tail), preserving the group's
          // chronological order in both collapsed and expanded states
          // (review finding: concatenating two filtered lists moved a
          // mid-group spawn row above earlier tool rows).
          const overflowCandidates = visibleGroupedEntries.filter(
            (entry) => entry.agentSpawn === undefined,
          );
          const hiddenEntries = overflowCandidates.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES);
          const hiddenIds = new Set(hiddenEntries.map((entry) => entry.id));
          const visibleEntries = visibleGroupedEntries.filter(
            (entry) => entry.agentSpawn !== undefined || !hiddenIds.has(entry.id),
          );
          const renderedEntries = expanded ? visibleGroupedEntries : visibleEntries;

          for (const workEntry of renderedEntries) {
            nextRows.push({
              kind: "work",
              id: workEntry.id,
              createdAt: workEntry.createdAt,
              groupedEntries: [workEntry],
            });
          }

          if (hiddenEntries.length > 0) {
            nextRows.push({
              kind: "work-toggle",
              id: `work-toggle:${timelineEntry.id}`,
              createdAt: timelineEntry.createdAt,
              groupId,
              hiddenCount: hiddenEntries.length,
              expanded,
              onlyToolEntries,
              summary: null,
              summaryKind: null,
              hasFailure: visibleGroupedEntries.some((entry) =>
                workEntryIndicatesToolFailure(entry),
              ),
            });
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
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      showThinking: !activeTurnHasVisibleContent,
    });
  }

  return nextRows;
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
      return (
        a.createdAt === (b as typeof a).createdAt && a.showThinking === (b as typeof a).showThinking
      );

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "turn-plan": {
      const bp = b as typeof a;
      // Plans rewrite in place: compare the snapshot's identity fields so an
      // unchanged plan keeps its row reference (virtualization stability).
      return a.createdAt === bp.createdAt && a.turnPlan.plan === bp.turnPlan.plan;
    }

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "work-live":
      return a.active === (b as typeof a).active && Equal.equals(a.entry, (b as typeof a).entry);

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.onlyToolEntries === bw.onlyToolEntries &&
        a.summary === bw.summary &&
        a.summaryKind === bw.summaryKind &&
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
