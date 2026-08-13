import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

/**
 * Centralized page budgets for progressive client hydration. Sized for relay
 * cold opens: dozens of rows and about 1 MiB of encoded JSON per page.
 */
export const THREAD_HISTORY_PAGE_POLICY = {
  maxItems: 75,
  maxEncodedBytes: 1_048_576,
} as const;

/** Reject absurd cursors before base64 work or JSON parse. */
export const THREAD_HISTORY_CURSOR_MAX_LENGTH = 4_096;

export type ThreadHistoryPagePolicy = {
  readonly maxItems: number;
  readonly maxEncodedBytes: number;
};

export type ThreadHistoryCursorPayload = {
  readonly v: 1;
  readonly seq: number;
  readonly st: string;
  readonly si: string;
  readonly p: number;
};

export type SelectTimelinePageResult = {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly nextCursor: string | null;
  readonly hasMoreHistory: boolean;
};

export type BoundedProjectionResult = {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  /** Max ordinal across the authoritative full projection's local turnItems. */
  readonly latestLocalTurnOrdinal: number | null;
};

export class InvalidThreadHistoryCursorError extends Error {
  readonly _tag = "InvalidThreadHistoryCursorError";
  constructor(message = "Invalid thread history cursor.") {
    super(message);
    this.name = "InvalidThreadHistoryCursorError";
  }
}

function bytesOfJson(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Ordinary history-page cost: one projected row (item is nested once). */
export function projectedRowEncodedBytes(row: OrchestrationV2ProjectedTurnItem): number {
  return bytesOfJson(row);
}

/**
 * Bounded-snapshot cost: local rows also land in `projection.turnItems`, so
 * charge the nested item a second time. Inherited rows only appear in the
 * visible list.
 */
export function projectedRowBoundedSnapshotEncodedBytes(
  row: OrchestrationV2ProjectedTurnItem,
  threadId: ThreadId | string,
): number {
  const rowBytes = projectedRowEncodedBytes(row);
  if (row.visibility === "local" || String(row.sourceThreadId) === String(threadId)) {
    return rowBytes + bytesOfJson(row.item);
  }
  return rowBytes;
}

function renumberPositions(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ProjectedTurnItem[] {
  return items.map((row, position) => (row.position === position ? row : { ...row, position }));
}

function encodeCursorPayload(payload: ThreadHistoryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function encodeThreadHistoryCursor(input: {
  readonly snapshotSequence: number;
  readonly sourceThreadId: ThreadId | string;
  readonly sourceItemId: TurnItemId | string;
  readonly position: number;
}): string {
  return encodeCursorPayload({
    v: 1,
    seq: input.snapshotSequence,
    st: String(input.sourceThreadId),
    si: String(input.sourceItemId),
    p: input.position,
  });
}

export function decodeThreadHistoryCursor(cursor: string): ThreadHistoryCursorPayload {
  if (cursor.length === 0 || cursor.length > THREAD_HISTORY_CURSOR_MAX_LENGTH) {
    throw new InvalidThreadHistoryCursorError();
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new InvalidThreadHistoryCursorError();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("v" in parsed) ||
    (parsed as { v: unknown }).v !== 1 ||
    !("seq" in parsed) ||
    typeof (parsed as { seq: unknown }).seq !== "number" ||
    !Number.isInteger((parsed as { seq: number }).seq) ||
    (parsed as { seq: number }).seq < 0 ||
    !("st" in parsed) ||
    typeof (parsed as { st: unknown }).st !== "string" ||
    (parsed as { st: string }).st.length === 0 ||
    !("si" in parsed) ||
    typeof (parsed as { si: unknown }).si !== "string" ||
    (parsed as { si: string }).si.length === 0 ||
    !("p" in parsed) ||
    typeof (parsed as { p: unknown }).p !== "number" ||
    !Number.isInteger((parsed as { p: number }).p) ||
    (parsed as { p: number }).p < 0
  ) {
    throw new InvalidThreadHistoryCursorError();
  }
  return parsed as ThreadHistoryCursorPayload;
}

/**
 * Walk a chronological timeline from `startIndex` backward, collecting rows
 * under count and byte budgets. Always includes at least one row when available
 * so a single oversized item cannot deadlock pagination.
 */
export function selectOlderTimelinePage(input: {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly exclusiveEndIndex: number;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly rowEncodedBytes?: ((row: OrchestrationV2ProjectedTurnItem) => number) | undefined;
}): SelectTimelinePageResult {
  const policy = input.policy ?? THREAD_HISTORY_PAGE_POLICY;
  const rowCost = input.rowEncodedBytes ?? projectedRowEncodedBytes;
  const end = Math.min(Math.max(input.exclusiveEndIndex, 0), input.items.length);
  if (end <= 0) {
    return { items: [], nextCursor: null, hasMoreHistory: false };
  }

  const selected: OrchestrationV2ProjectedTurnItem[] = [];
  let encodedBytes = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    const row = input.items[index]!;
    const rowBytes = rowCost(row);
    if (
      selected.length > 0 &&
      (selected.length >= policy.maxItems || encodedBytes + rowBytes > policy.maxEncodedBytes)
    ) {
      break;
    }
    selected.push(row);
    encodedBytes += rowBytes;
  }
  selected.reverse();

  const oldest = selected[0];
  const oldestIndex = oldest
    ? input.items.findIndex(
        (row) =>
          row.sourceThreadId === oldest.sourceThreadId && row.sourceItemId === oldest.sourceItemId,
      )
    : -1;
  const hasMoreHistory = oldestIndex > 0;
  const nextCursor =
    hasMoreHistory && oldest
      ? encodeThreadHistoryCursor({
          snapshotSequence: input.snapshotSequence,
          sourceThreadId: oldest.sourceThreadId,
          sourceItemId: oldest.sourceItemId,
          position: oldest.position,
        })
      : null;

  return {
    items: renumberPositions(selected),
    nextCursor,
    hasMoreHistory,
  };
}

export function selectRecentTimelineWindow(input: {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly rowEncodedBytes?: ((row: OrchestrationV2ProjectedTurnItem) => number) | undefined;
}): SelectTimelinePageResult {
  return selectOlderTimelinePage({
    items: input.items,
    exclusiveEndIndex: input.items.length,
    snapshotSequence: input.snapshotSequence,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.rowEncodedBytes === undefined ? {} : { rowEncodedBytes: input.rowEncodedBytes }),
  });
}

function findCursorIndex(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  cursor: ThreadHistoryCursorPayload,
): number {
  const byIdentity = items.findIndex(
    (row) => String(row.sourceThreadId) === cursor.st && String(row.sourceItemId) === cursor.si,
  );
  if (byIdentity !== -1) {
    return byIdentity;
  }
  // Identity miss can happen if the cursor item was deleted; fall back to the
  // recorded position clamped into the current timeline so pagination can
  // continue from a stable-ish anchor rather than failing hard. Clamp to
  // items.length (exclusive end) so a shrunken timeline never 400s forever.
  // decodeThreadHistoryCursor already guarantees p is a non-negative integer.
  return Math.min(cursor.p, items.length);
}

export function selectHistoryPageFromCursor(input: {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly cursor: string;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
}): SelectTimelinePageResult {
  const decoded = decodeThreadHistoryCursor(input.cursor);
  const anchorIndex = findCursorIndex(input.items, decoded);
  return selectOlderTimelinePage({
    items: input.items,
    exclusiveEndIndex: anchorIndex,
    snapshotSequence: input.snapshotSequence,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
  });
}

function isLocalProjectedRow(
  projection: OrchestrationV2ThreadProjection,
  row: OrchestrationV2ProjectedTurnItem,
): boolean {
  return row.visibility === "local" || String(row.sourceThreadId) === String(projection.thread.id);
}

/**
 * Visibility for superseded `run_interrupt_result` rows depends on a matching
 * `run_interrupt_request` in `turnItems`. Keep every small request item from the
 * full projection even when it sits outside the recent visible window, so a
 * later history page that introduces the matching result still has the request
 * available for live attempt/run reducers.
 */
export function retainedInterruptRequestTurnItems(
  projection: OrchestrationV2ThreadProjection,
  visible: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2TurnItem[] {
  const visibleLocalIds = new Set<string>();
  for (const row of visible) {
    if (isLocalProjectedRow(projection, row)) {
      visibleLocalIds.add(String(row.sourceItemId));
    }
  }

  const retained: OrchestrationV2TurnItem[] = [];
  for (const item of projection.turnItems) {
    if (item.type !== "run_interrupt_request") {
      continue;
    }
    // Already covered by local turnItems for the visible window.
    if (visibleLocalIds.has(String(item.id))) {
      continue;
    }
    retained.push(item);
  }
  return retained;
}

function localTurnItemsForVisibleWindow(
  projection: OrchestrationV2ThreadProjection,
  visible: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2TurnItem[] {
  const localIds = new Set<string>();
  for (const row of visible) {
    if (isLocalProjectedRow(projection, row)) {
      localIds.add(String(row.sourceItemId));
    }
  }
  if (localIds.size === 0) {
    return [];
  }
  return projection.turnItems.filter((item) => localIds.has(String(item.id)));
}

function messagesForBoundedProjection(
  projection: OrchestrationV2ThreadProjection,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ThreadProjection["messages"] {
  const retainedMessageIds = new Set<string>();
  for (const item of turnItems) {
    if ("messageId" in item) {
      retainedMessageIds.add(String(item.messageId));
    }
  }

  const latestRun = projection.runs.reduce<(typeof projection.runs)[number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  const retainedRunIds = new Set<string>();
  for (const run of projection.runs) {
    if (
      run.id === latestRun?.id ||
      run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting" ||
      run.status === "queued"
    ) {
      retainedRunIds.add(String(run.id));
      retainedMessageIds.add(String(run.userMessageId));
    }
  }

  return projection.messages.filter(
    (message) =>
      retainedMessageIds.has(String(message.id)) ||
      (message.runId !== null && retainedRunIds.has(String(message.runId))) ||
      message.delegatedCompletion !== undefined,
  );
}

/**
 * Max local turn ordinal over the authoritative full projection turnItems.
 * Used as a cheap partial-timeline watermark so old missing turn-item updates
 * cannot append newest when the bounded window has no local rows.
 */
export function computeLatestLocalTurnOrdinal(
  turnItems: ReadonlyArray<{ readonly ordinal: number }>,
): number | null {
  let latest: number | null = null;
  for (const item of turnItems) {
    if (latest === null || item.ordinal > latest) {
      latest = item.ordinal;
    }
  }
  return latest;
}

/**
 * Encoded timeline contribution for a bounded snapshot: visible rows plus the
 * duplicated local turnItems and any retained interrupt-request dependencies.
 */
export function boundedTimelineEncodedBytes(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): number {
  let total = 0;
  for (const row of input.visibleTurnItems) {
    total += projectedRowEncodedBytes(row);
  }
  for (const item of input.turnItems) {
    total += bytesOfJson(item);
  }
  return total;
}

/**
 * Builds a partial thread projection with full control-plane arrays and a
 * bounded recent timeline window plus matching local turnItems.
 */
export function buildBoundedThreadProjection(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
}): BoundedProjectionResult {
  const policy = input.policy ?? THREAD_HISTORY_PAGE_POLICY;
  const threadId = input.projection.thread.id;

  // Reserve bytes for small interrupt-request dependencies that may sit outside
  // the recent window but are required for visibility of results inside it.
  const dependencyReserve = (() => {
    // Upper bound: all request items in the full projection. Window selection
    // uses this reserve so the final contribution stays under the cap.
    let reserve = 0;
    for (const item of input.projection.turnItems) {
      if (item.type === "run_interrupt_request") {
        reserve += bytesOfJson(item);
      }
    }
    return reserve;
  })();
  const windowBudget = Math.max(0, policy.maxEncodedBytes - dependencyReserve);
  const windowPolicy: ThreadHistoryPagePolicy = {
    maxItems: policy.maxItems,
    // Zero still admits the first row via the at-least-one rule.
    maxEncodedBytes: windowBudget,
  };

  const window = selectRecentTimelineWindow({
    items: input.projection.visibleTurnItems,
    snapshotSequence: input.snapshotSequence,
    policy: windowPolicy,
    rowEncodedBytes: (row) => projectedRowBoundedSnapshotEncodedBytes(row, threadId),
  });
  const visibleTurnItems = renumberPositions(window.items);
  const windowTurnItems = localTurnItemsForVisibleWindow(input.projection, visibleTurnItems);
  const dependencyTurnItems = retainedInterruptRequestTurnItems(input.projection, visibleTurnItems);
  const turnItemById = new Map<string, OrchestrationV2TurnItem>();
  for (const item of windowTurnItems) {
    turnItemById.set(String(item.id), item);
  }
  for (const item of dependencyTurnItems) {
    turnItemById.set(String(item.id), item);
  }
  const turnItems = [...turnItemById.values()];

  return {
    projection: {
      ...input.projection,
      messages: messagesForBoundedProjection(input.projection, turnItems),
      turnItems,
      visibleTurnItems,
    },
    historyCursor: window.nextCursor,
    hasMoreHistory: window.hasMoreHistory,
    // Always from the full projection so inherited-only windows still carry a
    // watermark for partial live reducers.
    latestLocalTurnOrdinal: computeLatestLocalTurnOrdinal(input.projection.turnItems),
  };
}
