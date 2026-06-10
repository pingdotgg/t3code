import { formatElapsed, type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type TurnId } from "@t3tools/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

type BaseMessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      shouldAutoCollapse: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      showAssistantCopyButton: boolean;
      showAssistantTerminalMetadata: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export type MessagesTimelineRow =
  | BaseMessagesTimelineRow
  | {
      kind: "reasoning";
      id: string;
      createdAt: string;
      workedFor: string | null;
      rows: BaseMessagesTimelineRow[];
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export type WorkGroupExpansionOverride = "expanded" | "collapsed" | null;

export function resolveWorkGroupExpanded({
  shouldAutoCollapse,
  expansionOverride,
}: {
  shouldAutoCollapse: boolean;
  expansionOverride: WorkGroupExpansionOverride;
}): boolean {
  if (expansionOverride === "expanded") return true;
  if (expansionOverride === "collapsed") return false;
  return !shouldAutoCollapse;
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
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
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

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  isWorking: boolean;
  activeTurnId: TurnId | null | undefined;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: BaseMessagesTimelineRow[] = [];
  // Last assistant message row per response key (turn). Only the final
  // assistant message of each turn is "terminal" and shows copy/terminal
  // affordances. Tracking the row references here lets us fold what used to be
  // a separate terminal pre-pass and a separate flatMap post-pass into the
  // single build loop below, then finalize over just these rows.
  const lastAssistantRowByResponseKey = new Map<
    string,
    Extract<BaseMessagesTimelineRow, { kind: "message" }>
  >();
  let nullTurnResponseIndex = 0;
  let lastDurationBoundary: string | null = null;

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const nextEntry = input.timelineEntries[cursor];
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
        shouldAutoCollapse: shouldAutoCollapseWorkGroup({
          groupedEntries,
          nextEntry,
          isWorking: input.isWorking,
        }),
      });
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

    const message = timelineEntry.message;
    if (message.role === "user") {
      lastDurationBoundary = message.createdAt;
      nullTurnResponseIndex += 1;
    }
    const durationStart = lastDurationBoundary ?? message.createdAt;

    const messageRow: Extract<BaseMessagesTimelineRow, { kind: "message" }> = {
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message,
      durationStart,
      showCompletionDivider:
        message.role === "assistant" && input.completionDividerBeforeEntryId === timelineEntry.id,
      // Terminal-only affordances; resolved in the finalize pass below once we
      // know which assistant row is the last of its turn.
      showAssistantCopyButton: false,
      showAssistantTerminalMetadata: false,
      assistantTurnDiffSummary:
        message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(message.id)
          : undefined,
      revertTurnCount:
        message.role === "user" ? input.revertTurnCountByUserMessageId.get(message.id) : undefined,
    };
    nextRows.push(messageRow);

    if (message.role === "assistant") {
      const responseKey = message.turnId
        ? `turn:${message.turnId}`
        : `unkeyed:${nullTurnResponseIndex}`;
      lastAssistantRowByResponseKey.set(responseKey, messageRow);
      if (message.completedAt) {
        lastDurationBoundary = message.completedAt;
      }
    }
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  // Finalize over just the terminal rows (at most one per turn) rather than
  // rescanning the whole timeline: flag terminal affordances and collect the
  // completed-response boundaries used to group reasoning rows.
  const completedResponseEntryIds = new Set<string>();
  for (const terminalRow of lastAssistantRowByResponseKey.values()) {
    terminalRow.showAssistantCopyButton = true;
    terminalRow.showAssistantTerminalMetadata = true;

    const { message } = terminalRow;
    if (
      message.completedAt &&
      (!input.isWorking || !input.activeTurnId || message.turnId !== input.activeTurnId)
    ) {
      completedResponseEntryIds.add(terminalRow.id);
    }
  }
  if (input.completionDividerBeforeEntryId) {
    completedResponseEntryIds.add(input.completionDividerBeforeEntryId);
  }

  return collapseReasoningRows(nextRows, completedResponseEntryIds);
}

function collapseReasoningRows(
  rows: BaseMessagesTimelineRow[],
  responseEntryIds: ReadonlySet<string>,
): MessagesTimelineRow[] {
  if (responseEntryIds.size === 0) return rows;

  const collapsedRows: MessagesTimelineRow[] = [];
  let userIndex = -1;
  let reasoningRows: BaseMessagesTimelineRow[] = [];

  for (const row of rows) {
    if (row.kind === "message" && row.message.role === "user") {
      collapsedRows.push(...reasoningRows);
      collapsedRows.push(row);
      userIndex = collapsedRows.length - 1;
      reasoningRows = [];
      continue;
    }

    if (
      row.kind === "message" &&
      row.message.role === "assistant" &&
      responseEntryIds.has(row.id) &&
      reasoningRows.length > 0
    ) {
      const userRow = userIndex >= 0 ? collapsedRows[userIndex] : undefined;
      const startedAt = userRow?.createdAt ?? reasoningRows[0]?.createdAt;
      const workedFor = startedAt ? formatElapsed(startedAt, row.createdAt) : null;
      collapsedRows.push({
        kind: "reasoning",
        id: `reasoning:${row.id}`,
        createdAt: reasoningRows[0]?.createdAt ?? row.createdAt,
        workedFor,
        rows: reasoningRows,
      });
      reasoningRows = [];
      collapsedRows.push(row);
      continue;
    }

    if (userIndex >= 0) {
      reasoningRows.push(row);
      continue;
    }

    collapsedRows.push(row);
  }

  collapsedRows.push(...reasoningRows);
  return collapsedRows;
}

function shouldAutoCollapseWorkGroup({
  groupedEntries,
  nextEntry,
  isWorking,
}: {
  groupedEntries: ReadonlyArray<WorkLogEntry>;
  nextEntry: TimelineEntry | undefined;
  isWorking: boolean;
}): boolean {
  if (groupedEntries.length <= 1) return false;
  if (isWorking) return isAssistantTextBoundary(nextEntry);
  return true;
}

function isAssistantTextBoundary(entry: TimelineEntry | undefined): boolean {
  return (
    entry?.kind === "message" &&
    entry.message.role === "assistant" &&
    entry.message.text.trim().length > 0
  );
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
      return a.createdAt === (b as typeof a).createdAt;

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work":
      return areWorkRowsUnchanged(a, b as typeof a);

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showCompletionDivider === bm.showCompletionDivider &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.showAssistantTerminalMetadata === bm.showAssistantTerminalMetadata &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }

    case "reasoning":
      return (
        a.workedFor === (b as typeof a).workedFor &&
        a.rows === (b as typeof a).rows &&
        a.createdAt === (b as typeof a).createdAt
      );
  }
}

function areWorkRowsUnchanged(
  a: Extract<MessagesTimelineRow, { kind: "work" }>,
  b: Extract<MessagesTimelineRow, { kind: "work" }>,
): boolean {
  if (a.shouldAutoCollapse !== b.shouldAutoCollapse) return false;
  if (a.groupedEntries === b.groupedEntries) return true;
  if (a.groupedEntries.length !== b.groupedEntries.length) return false;
  for (let index = 0; index < a.groupedEntries.length; index += 1) {
    const previous = a.groupedEntries[index];
    const next = b.groupedEntries[index];
    if (!previous || !next || !areWorkLogEntriesUnchanged(previous, next)) {
      return false;
    }
  }
  return true;
}

function areWorkLogEntriesUnchanged(a: WorkLogEntry, b: WorkLogEntry): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.createdAt === b.createdAt &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.command === b.command &&
    a.rawCommand === b.rawCommand &&
    a.tone === b.tone &&
    a.toolTitle === b.toolTitle &&
    a.itemType === b.itemType &&
    a.requestKind === b.requestKind &&
    a.isComplete === b.isComplete &&
    areStringArraysUnchanged(a.changedFiles, b.changedFiles)
  );
}

function areStringArraysUnchanged(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
