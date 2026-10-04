import { formatElapsed, type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import {
  type CrossThreadSendRecord,
  type DelegationAuditEvent,
  type MessageId,
  type ThreadContextRecord,
  type TurnId,
  type WorkspaceHandoffOrigin,
} from "@t3tools/contracts";
import { isReviewOutputText } from "@t3tools/shared/workflows/reviewOutput";
import { collectThreadContextReferences } from "@t3tools/shared/threadContext";

export interface TimelineThreadContextChip {
  /** Context identity: stable React key and record binding, never the label. */
  key: string;
  title: string;
  /** True when no record backs the reference: render as unavailable, never as a live thread. */
  unavailable: boolean;
}

/**
 * Chips for one timeline message, in first-reference order. Every inline
 * reference resolves to its structured record (live title with label
 * fallback) or is marked unavailable when the record is gone. Unreferenced
 * records are never surfaced: they were never sent to the provider.
 */
export function selectTimelineThreadContextChips(message: {
  text: string;
  context?: { records?: ReadonlyArray<ThreadContextRecord> } | undefined;
}): TimelineThreadContextChip[] {
  const recordsById = new Map<string, ThreadContextRecord>();
  for (const record of message.context?.records ?? []) {
    const key = String(record.contextId);
    if (!recordsById.has(key)) recordsById.set(key, record);
  }
  const chips: TimelineThreadContextChip[] = [];
  const seen = new Set<string>();
  for (const occurrence of collectThreadContextReferences(message.text)) {
    const key = String(occurrence.contextId);
    if (seen.has(key)) continue;
    seen.add(key);
    const record = recordsById.get(key);
    if (!record) {
      chips.push({ key, title: occurrence.label, unavailable: true });
      continue;
    }
    const title =
      record.title?.trim().length > 0
        ? record.title
        : record.label?.trim().length > 0
          ? record.label
          : occurrence.label;
    chips.push({ key, title, unavailable: false });
  }
  return chips;
}

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
export const EMPTY_REVIEW_OUTPUT_MESSAGE_IDS: ReadonlySet<string> = new Set();

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export interface DelegationOperationSummary {
  readonly operationId: string | null;
  readonly operationStatus: "succeeded" | "failed" | "failed-with-unresolved" | "unresolved";
  readonly toolTransport: "completed" | "failed" | "unknown";
}

export function deriveDelegationOperationSummary(
  events: ReadonlyArray<DelegationAuditEvent>,
  sourceTurnId: TurnId | null | undefined,
  toolCallId: string | null | undefined,
): DelegationOperationSummary | null {
  if (!sourceTurnId || !toolCallId) {
    return null;
  }

  const correlatedEvents = events.filter(
    (event) => event.sourceTurnId === sourceTurnId && event.context.toolCallId === toolCallId,
  );
  const operationIds = new Set(correlatedEvents.map((event) => event.operationId));
  if (operationIds.size === 0) {
    return null;
  }
  if (operationIds.size > 1) {
    return {
      operationId: null,
      operationStatus: "unresolved",
      toolTransport: "unknown",
    };
  }

  const operationId = operationIds.values().next().value;
  if (operationId === undefined) {
    return null;
  }
  const operationEvents = correlatedEvents.filter((event) => event.operationId === operationId);
  let terminalEvent: DelegationAuditEvent | undefined;
  for (const event of operationEvents) {
    if (
      (event.eventType === "operation.completed" || event.eventType === "operation.failed") &&
      (terminalEvent === undefined || event.sequence > terminalEvent.sequence)
    ) {
      terminalEvent = event;
    }
  }
  if (terminalEvent === undefined) {
    return {
      operationId,
      operationStatus: "unresolved",
      toolTransport: "unknown",
    };
  }

  const payload =
    typeof terminalEvent.payload === "object" &&
    terminalEvent.payload !== null &&
    !Array.isArray(terminalEvent.payload)
      ? (terminalEvent.payload as Record<string, unknown>)
      : null;
  const operationStatus =
    terminalEvent.eventType === "operation.failed" && payload?.operationStatus === "failed"
      ? Array.isArray(payload.unresolvedAttemptIds) && payload.unresolvedAttemptIds.length > 0
        ? "failed-with-unresolved"
        : "failed"
      : terminalEvent.eventType === "operation.completed" &&
          payload?.operationStatus === "succeeded"
        ? "succeeded"
        : "unresolved";
  const toolTransport =
    payload?.toolTransport === "completed" || payload?.toolTransport === "failed"
      ? payload.toolTransport
      : "unknown";

  return {
    operationId,
    operationStatus,
    toolTransport,
  };
}

type BaseMessagesTimelineRow =
  | {
      kind: "context-compaction";
      id: string;
      createdAt: string;
      label: string;
    }
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
      /** Messages this turn pushed into other threads, in send order. */
      crossThreadSends?: readonly CrossThreadSendRecord[] | undefined;
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
      kind: "workspace-handoff";
      id: string;
      createdAt: string;
      origin: WorkspaceHandoffOrigin;
      revertMessageId?: MessageId | undefined;
      revertTurnCount?: number | undefined;
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

export function resolveExternalActionUrl(actionUrl: string): string | null {
  try {
    const target = new URL(actionUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return null;
    }
    return target.href;
  } catch {
    return null;
  }
}

export function shouldHandleInternalActionClick(input: {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return input.button === 0 && !input.metaKey && !input.ctrlKey && !input.shiftKey && !input.altKey;
}

/**
 * Collect assistant message ids whose body is structured review output.
 * Returns a shared empty set when inactive/empty so timeline context stays
 * referentially stable across streaming chunks that only change other rows.
 */
export function collectReviewOutputMessageIds(
  rows: ReadonlyArray<MessagesTimelineRow>,
  reviewResultActive: boolean,
): ReadonlySet<string> {
  if (!reviewResultActive) {
    return EMPTY_REVIEW_OUTPUT_MESSAGE_IDS;
  }

  const ids = new Set<string>();
  for (const entry of rows) {
    if (
      entry.kind === "message" &&
      entry.message.role === "assistant" &&
      isReviewOutputText(entry.message.text ?? "")
    ) {
      ids.add(entry.id);
    }
  }
  return ids.size === 0 ? EMPTY_REVIEW_OUTPUT_MESSAGE_IDS : ids;
}

/** Reuse the previous set when membership is unchanged. */
export function stabilizeReadonlyStringSet(
  next: ReadonlySet<string>,
  previous: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (previous === undefined || previous === next) {
    return next;
  }
  if (previous.size !== next.size) {
    return next;
  }
  for (const value of next) {
    if (!previous.has(value)) {
      return next;
    }
  }
  return previous;
}

/** Reuse the previous map when string key/value entries are unchanged. */
export function stabilizeStringMap(
  next: ReadonlyMap<string, string>,
  previous: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> {
  if (previous === undefined || previous === next) {
    return next;
  }
  if (previous.size !== next.size) {
    return next;
  }
  for (const [key, value] of next) {
    if (previous.get(key) !== value) {
      return next;
    }
  }
  return previous;
}

export interface StabilizableAssistantResponseMeta {
  readonly model?: string | undefined;
  readonly usedTokens?: number | undefined;
  readonly cost?: { readonly amount: number; readonly currency: string } | undefined;
}

/** Shallow value equality for per-turn response metadata entries. */
export function isAssistantResponseMetaEqual(
  a: StabilizableAssistantResponseMeta,
  b: StabilizableAssistantResponseMeta,
): boolean {
  if (a === b) {
    return true;
  }
  if (a.model !== b.model || a.usedTokens !== b.usedTokens) {
    return false;
  }
  if (a.cost === b.cost) {
    return true;
  }
  if (a.cost === undefined || b.cost === undefined) {
    return false;
  }
  return a.cost.amount === b.cost.amount && a.cost.currency === b.cost.currency;
}

/**
 * Reuse previous per-turn entry objects (and the map itself) when values are
 * unchanged. Producers rebuild fresh `{...existing}` objects on every
 * `threadActivities` change, which would otherwise defeat the memoized
 * assistant presentational below even for untouched settled turns.
 */
export function stabilizeResponseMetaByTurnId<
  TurnKey,
  Meta extends StabilizableAssistantResponseMeta,
>(
  next: ReadonlyMap<TurnKey, Meta>,
  previous: ReadonlyMap<TurnKey, Meta> | undefined,
): ReadonlyMap<TurnKey, Meta> {
  if (previous === undefined || previous === next) {
    return next;
  }
  if (previous.size !== next.size) {
    return next;
  }
  // Reuse previous entry objects when values are equal so memoized consumers
  // below keep stable props across streaming chunks, even while the active
  // turn's entry changes every chunk. When every entry is already identical,
  // return the previous map itself.
  let identical = true;
  let changed = false;
  const result = new Map<TurnKey, Meta>();
  for (const [key, value] of next) {
    const previousValue = previous.get(key);
    if (previousValue === undefined || !isAssistantResponseMetaEqual(previousValue, value)) {
      result.set(key, value);
      identical = false;
      changed = true;
      continue;
    }
    result.set(key, previousValue);
    if (previousValue !== value) {
      identical = false;
    }
  }
  if (changed) {
    return result;
  }
  return identical ? previous : result;
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

/**
 * Maps each user message to the checkpoint turn count of the turn that
 * answered it (minus one, for revert targeting). Each user message resolves
 * against the first following assistant message carrying a numeric
 * checkpoint turn count; assistants without summaries are skipped, while a
 * non-numeric summary or a following user message discards the pending user.
 *
 * Single forward pass over already-ordered entries.
 */
export function deriveRevertTurnCountByUserMessageId(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Record<TurnId, number>;
}): Map<MessageId, number> {
  const byUserMessageId = new Map<MessageId, number>();
  let pendingUserMessageId: MessageId | null = null;
  for (const entry of input.timelineEntries) {
    if (!entry || entry.kind !== "message") {
      continue;
    }
    if (entry.message.role === "user") {
      pendingUserMessageId = entry.message.id;
      continue;
    }
    if (pendingUserMessageId === null) {
      continue;
    }
    const summary = input.turnDiffSummaryByAssistantMessageId.get(entry.message.id);
    if (!summary) {
      continue;
    }
    const turnCount =
      summary.checkpointTurnCount ?? input.inferredCheckpointTurnCountByTurnId[summary.turnId];
    const userMessageId = pendingUserMessageId;
    pendingUserMessageId = null;
    if (typeof turnCount !== "number") {
      continue;
    }
    byUserMessageId.set(userMessageId, Math.max(0, turnCount - 1));
  }
  return byUserMessageId;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  isWorking: boolean;
  activeTurnId: TurnId | null | undefined;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  crossThreadSendsBySourceMessageId: ReadonlyMap<MessageId, readonly CrossThreadSendRecord[]>;
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
  const handoffRowsAwaitingContinuation: Extract<
    BaseMessagesTimelineRow,
    { kind: "workspace-handoff" }
  >[] = [];

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
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
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.sourceActivityKind === "context-compaction"
        )
          break;
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

    // Workspace handoffs render as a single transition marker. The marker is
    // emitted when the provider moves worktrees, so it must stay in that exact
    // position: work logged after the move belongs below the transition rather
    // than being rendered above it while we wait for the hidden continuation.
    // The continuation remains a turn boundary but never becomes a bubble, and
    // it hands its revert anchor to the marker so the post-handoff turn stays
    // revertable.
    if (message.origin?.kind === "workspace-handoff") {
      if (message.origin.role === "marker") {
        const handoffRow: Extract<BaseMessagesTimelineRow, { kind: "workspace-handoff" }> = {
          kind: "workspace-handoff",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          origin: message.origin,
        };
        nextRows.push(handoffRow);
        handoffRowsAwaitingContinuation.push(handoffRow);
        lastDurationBoundary = handoffRow.createdAt;
      } else {
        const revertTurnCount = input.revertTurnCountByUserMessageId.get(message.id);
        const lastHandoffRow = handoffRowsAwaitingContinuation.pop();
        if (lastHandoffRow) {
          if (revertTurnCount !== undefined) {
            lastHandoffRow.revertMessageId = message.id;
            lastHandoffRow.revertTurnCount = revertTurnCount;
          }
          // The hidden continuation is still a user-role turn boundary. Keep
          // elapsed time anchored to the visible transition rather than to the
          // boilerplate row the user never sees.
          lastDurationBoundary = lastHandoffRow.createdAt;
        }
      }
      continue;
    }

    if (message.role === "user" && handoffRowsAwaitingContinuation.length > 0) {
      handoffRowsAwaitingContinuation.length = 0;
    }

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
      crossThreadSends:
        message.role === "user"
          ? input.crossThreadSendsBySourceMessageId.get(message.id)
          : undefined,
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

    // The handoff is a turn boundary, so the following response's elapsed time
    // is measured from the move rather than from the pre-handoff user message.
    if (row.kind === "workspace-handoff") {
      if (reasoningRows.length > 0) {
        const userRow = userIndex >= 0 ? collapsedRows[userIndex] : undefined;
        const startedAt = userRow?.createdAt ?? reasoningRows[0]?.createdAt;
        collapsedRows.push({
          kind: "reasoning",
          id: `reasoning:${row.id}:before`,
          createdAt: reasoningRows[0]?.createdAt ?? row.createdAt,
          workedFor: startedAt ? formatElapsed(startedAt, row.createdAt) : null,
          rows: reasoningRows,
        });
        reasoningRows = [];
      }
      collapsedRows.push(row);
      userIndex = collapsedRows.length - 1;
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
      // Compaction marks a context boundary, not hidden reasoning. Partition
      // completed work around each marker without changing chronological order.
      let section: BaseMessagesTimelineRow[] = [];
      let sectionStartedAt = startedAt;
      const flushSection = (id: string, completedAt: string) => {
        if (section.length === 0) return;
        collapsedRows.push({
          kind: "reasoning",
          id: `reasoning:${id}`,
          createdAt: section[0]?.createdAt ?? completedAt,
          workedFor: sectionStartedAt ? formatElapsed(sectionStartedAt, completedAt) : null,
          rows: section,
        });
        section = [];
      };
      for (const entry of reasoningRows) {
        if (
          entry.kind === "message" &&
          !entry.message.text.trim() &&
          !entry.message.attachments?.length
        ) {
          continue;
        }
        if (entry.kind === "context-compaction") {
          flushSection(entry.id, entry.createdAt);
          collapsedRows.push(entry);
          sectionStartedAt = entry.createdAt;
        } else {
          section.push(entry);
        }
      }
      flushSection(row.id, row.createdAt);
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
  nextEntry,
  isWorking,
}: {
  nextEntry: TimelineEntry | undefined;
  isWorking: boolean;
}): boolean {
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
    case "context-compaction": {
      const compacted = b as typeof a;
      return a.createdAt === compacted.createdAt && a.label === compacted.label;
    }
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "workspace-handoff": {
      const bh = b as typeof a;
      return (
        a.origin.branch === bh.origin.branch &&
        a.origin.worktreePath === bh.origin.worktreePath &&
        a.revertMessageId === bh.revertMessageId &&
        a.revertTurnCount === bh.revertTurnCount &&
        a.createdAt === bh.createdAt
      );
    }

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
        areCrossThreadSendsUnchanged(a.crossThreadSends, bm.crossThreadSends) &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }

    case "reasoning":
      return areReasoningRowsUnchanged(a, b as typeof a);
  }
}

// Records are the activity payloads themselves, so an unchanged send keeps its
// identity across streaming chunks and must not invalidate the message row.
function areCrossThreadSendsUnchanged(
  a: readonly CrossThreadSendRecord[] | undefined,
  b: readonly CrossThreadSendRecord[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every(
    (record, index) =>
      record === b[index] ||
      (record.destinationThreadId === b[index]?.destinationThreadId &&
        record.destinationMessageId === b[index]?.destinationMessageId),
  );
}

function areReasoningRowsUnchanged(
  a: Extract<MessagesTimelineRow, { kind: "reasoning" }>,
  b: Extract<MessagesTimelineRow, { kind: "reasoning" }>,
): boolean {
  if (a.workedFor !== b.workedFor || a.createdAt !== b.createdAt) return false;
  if (a.rows === b.rows) return true;
  if (a.rows.length !== b.rows.length) return false;
  // collapseReasoningRows always allocates a fresh nested array, so compare
  // child rows by content the same way work groups compare groupedEntries.
  for (let index = 0; index < a.rows.length; index += 1) {
    const previous = a.rows[index];
    const next = b.rows[index];
    if (!previous || !next || !isRowUnchanged(previous, next)) {
      return false;
    }
  }
  return true;
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
    a.stableId === b.stableId &&
    a.turnId === b.turnId &&
    a.requestId === b.requestId &&
    a.childReportId === b.childReportId &&
    a.toolCallId === b.toolCallId &&
    a.toolLifecycleStatus === b.toolLifecycleStatus &&
    a.toolData === b.toolData &&
    a.sourceActivityKind === b.sourceActivityKind &&
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
