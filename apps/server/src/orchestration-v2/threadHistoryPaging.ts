import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

/**
 * Every window stops at the byte budget. A window that holds a user turn also
 * stops at `maxUserTurns` or `maxTurnItems` rows, which keeps ordinary turns
 * whole (V1 kept 500 activities). Any other window, such as an agent-driven
 * thread or the inside of one very long turn, stops at `maxItems` rows.
 */
export const THREAD_HISTORY_PAGE_POLICY = {
  maxUserTurns: 10,
  maxItems: 75,
  maxTurnItems: 500,
  maxEncodedBytes: 1_048_576,
} as const;

export const OLDER_THREAD_USER_TURN_LIMIT = 20;

export function isConversationHistoryItem(item: Pick<OrchestrationV2TurnItem, "type">): boolean {
  return !["command_execution", "reasoning", "file_change", "dynamic_tool"].includes(item.type);
}
export const THREAD_HISTORY_MAX_RAW_TURNS = 150;

export const THREAD_HISTORY_SNAPSHOT_ROW_LIMIT = THREAD_HISTORY_PAGE_POLICY.maxItems + 2;
/** The snapshot query's row limit once the history has a user turn. */
export const THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT = THREAD_HISTORY_PAGE_POLICY.maxTurnItems + 2;

const THREAD_HISTORY_CURSOR_MAX_LENGTH = 4_096;

export type ThreadHistoryPagePolicy = {
  readonly maxUserTurns?: number | undefined;
  readonly maxItems: number;
  /** Defaults to `maxItems`. */
  readonly maxTurnItems?: number | undefined;
  readonly maxEncodedBytes: number;
};

export type ThreadHistoryCursorPayload = {
  readonly v: 1;
  readonly seq: number;
  readonly st: string;
  readonly si: string;
  readonly p: number;
};

type HistoryRow = Pick<
  OrchestrationV2ProjectedTurnItem,
  "position" | "visibility" | "sourceThreadId" | "sourceItemId"
> & {
  readonly item: Pick<OrchestrationV2TurnItem, "type"> & {
    readonly id?: string;
    readonly messageId?: string;
    readonly inputIntent?: string;
    readonly createdBy?: string;
    readonly runId?: string | null;
  };
};
export type SelectTimelinePageResult<Row extends HistoryRow = OrchestrationV2ProjectedTurnItem> = {
  readonly items: ReadonlyArray<Row>;
  readonly nextCursor: string | null;
  readonly hasMoreHistory: boolean;
};

export type BoundedProjectionResult = {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
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

export function projectedRowEncodedBytes(row: HistoryRow): number {
  return bytesOfJson(row);
}

/** Charge local items twice because bounded snapshots also include projection.turnItems; inherited rows appear only once. */
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

function renumberPositions<Row extends HistoryRow>(items: ReadonlyArray<Row>): Row[] {
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
    parsed.v !== 1 ||
    !("seq" in parsed) ||
    typeof parsed.seq !== "number" ||
    !Number.isInteger(parsed.seq) ||
    parsed.seq < 0 ||
    !("st" in parsed) ||
    typeof parsed.st !== "string" ||
    parsed.st.length === 0 ||
    !("si" in parsed) ||
    typeof parsed.si !== "string" ||
    parsed.si.length === 0 ||
    !("p" in parsed) ||
    typeof parsed.p !== "number" ||
    !Number.isInteger(parsed.p) ||
    parsed.p < 0
  ) {
    throw new InvalidThreadHistoryCursorError();
  }
  return parsed as ThreadHistoryCursorPayload;
}

function isThreadHistoryTurnStart(item: HistoryRow["item"]): boolean {
  return (
    item.type === "user_message" &&
    (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn")
  );
}

/** Notifications can start wake turns when they are the run's first input; match ProjectionStore run_starts. */
function threadHistoryTurnStarts(items: ReadonlyArray<HistoryRow["item"]>): ReadonlyArray<boolean> {
  const startedRuns = new Set<string>();
  return items.map((item) => {
    if (item.type !== "user_message" && item.type !== "notification") return false;
    const firstInput = item.runId != null && !startedRuns.has(item.runId);
    if (item.runId != null) startedRuns.add(item.runId);
    return item.type === "notification" ? firstInput : isThreadHistoryTurnStart(item);
  });
}

export function isThreadHistoryUserTurn(item: HistoryRow["item"]): boolean {
  return (
    isThreadHistoryTurnStart(item) && item.type === "user_message" && item.createdBy === "user"
  );
}

/**
 * Always admit at least one row so oversized items cannot deadlock paging.
 */
function selectOlderTimelinePage<Row extends HistoryRow>(input: {
  readonly items: ReadonlyArray<Row>;
  readonly exclusiveEndIndex: number;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly rowEncodedBytes?: ((row: Row) => number) | undefined;
}): SelectTimelinePageResult<Row> {
  const policy = input.policy ?? THREAD_HISTORY_PAGE_POLICY;
  const rowCost = input.rowEncodedBytes ?? projectedRowEncodedBytes;
  const end = Math.min(Math.max(input.exclusiveEndIndex, 0), input.items.length);
  if (end <= 0) {
    return { items: [], nextCursor: null, hasMoreHistory: false };
  }

  const selected: Row[] = [];
  let encodedBytes = 0;
  let userTurns = 0;
  let rawTurns = 0;
  const candidates = input.items.slice(0, end);
  const turnStarts = threadHistoryTurnStarts(candidates.map((row) => row.item));
  const turnLimit = candidates.some((row) => isThreadHistoryUserTurn(row.item))
    ? policy.maxUserTurns
    : undefined;
  const maxItems =
    turnLimit === undefined ? policy.maxItems : (policy.maxTurnItems ?? policy.maxItems);
  for (let index = end - 1; index >= 0; index -= 1) {
    const row = input.items[index]!;
    const rowBytes = rowCost(row);
    if (
      selected.length > 0 &&
      (selected.length >= maxItems ||
        encodedBytes + rowBytes > policy.maxEncodedBytes ||
        (turnLimit !== undefined &&
          (userTurns >= turnLimit || rawTurns >= THREAD_HISTORY_MAX_RAW_TURNS)))
    ) {
      break;
    }
    selected.push(row);
    encodedBytes += rowBytes;
    if (isThreadHistoryUserTurn(row.item)) userTurns += 1;
    if (turnStarts[index]) rawTurns += 1;
  }
  // Inside a turn longer than the window, no selected row starts a user turn.
  // Later pages and the snapshot query see only such rows and use `maxItems`,
  // so this page uses it too.
  if (userTurns === 0) selected.splice(policy.maxItems);
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
  items: ReadonlyArray<Pick<HistoryRow, "sourceThreadId" | "sourceItemId">>,
  cursor: ThreadHistoryCursorPayload,
): number {
  const byIdentity = items.findIndex(
    (row) => String(row.sourceThreadId) === cursor.st && String(row.sourceItemId) === cursor.si,
  );
  if (byIdentity !== -1) {
    return byIdentity;
  }
  return Math.min(cursor.p, items.length);
}

/**
 * Older pages allow twice the turns, and a targeted page widens further so it
 * reaches `throughEntryId`. Callers that re-bound a page must reuse this policy
 * or they drop the target again.
 */
export function olderHistoryPagePolicy<Row extends HistoryRow>(input: {
  readonly items: ReadonlyArray<Row>;
  readonly cursor: string;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly throughEntryId?: string | undefined;
}): ThreadHistoryPagePolicy {
  const policy = input.policy ?? {
    ...THREAD_HISTORY_PAGE_POLICY,
    maxUserTurns: OLDER_THREAD_USER_TURN_LIMIT,
  };
  if (input.throughEntryId === undefined) return policy;
  const anchorIndex = findCursorIndex(input.items, decodeThreadHistoryCursor(input.cursor));
  const targetIndex = input.items.findIndex(
    (row) => (row.item.messageId ?? row.item.id) === input.throughEntryId,
  );
  if (targetIndex < 0 || targetIndex >= anchorIndex) return policy;
  const turns = input.items
    .slice(targetIndex, anchorIndex)
    .filter((row) => isThreadHistoryUserTurn(row.item)).length;
  return {
    ...policy,
    maxUserTurns: Math.min(
      OLDER_THREAD_USER_TURN_LIMIT * 2,
      Math.max(
        OLDER_THREAD_USER_TURN_LIMIT,
        turns + (isThreadHistoryUserTurn(input.items[targetIndex]!.item) ? 0 : 1),
      ),
    ),
    maxItems: policy.maxItems * 2,
    maxTurnItems: (policy.maxTurnItems ?? policy.maxItems) * 2,
  };
}

export function selectHistoryPageFromCursor<Row extends HistoryRow>(input: {
  readonly items: ReadonlyArray<Row>;
  readonly cursor: string;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly rowEncodedBytes?: ((row: Row) => number) | undefined;
  readonly throughEntryId?: string | undefined;
}): SelectTimelinePageResult<Row> {
  const decoded = decodeThreadHistoryCursor(input.cursor);
  return selectOlderTimelinePage({
    items: input.items,
    exclusiveEndIndex: findCursorIndex(input.items, decoded),
    snapshotSequence: input.snapshotSequence,
    ...(input.rowEncodedBytes === undefined ? {} : { rowEncodedBytes: input.rowEncodedBytes }),
    policy: olderHistoryPagePolicy(input),
  });
}

/**
 * Row and byte budgets can split a turn between an interrupt result and its
 * older request. Clients read a superseded result without a request as a
 * legacy steer and hide it, so a page carries the requests its results need.
 */
export function missingInterruptRequests<Row extends HistoryRow>(
  items: ReadonlyArray<Row>,
  page: ReadonlyArray<Pick<HistoryRow, "item" | "sourceThreadId" | "sourceItemId">>,
): Row[] {
  const runs = new Set<string>();
  for (const row of page) {
    if (row.item.type === "run_interrupt_result" && row.item.runId != null)
      runs.add(row.item.runId);
  }
  for (const row of page) {
    if (row.item.type === "run_interrupt_request" && row.item.runId != null)
      runs.delete(row.item.runId);
  }
  if (runs.size === 0) return [];
  return items.filter(
    (row) =>
      row.item.type === "run_interrupt_request" &&
      row.item.runId != null &&
      runs.has(row.item.runId),
  );
}

function isLocalProjectedRow(
  projection: OrchestrationV2ThreadProjection,
  row: OrchestrationV2ProjectedTurnItem,
): boolean {
  return row.visibility === "local" || String(row.sourceThreadId) === String(projection.thread.id);
}

/** Retain small requests outside the visible window; later result pages still need them for attempt/run reducers. */
function retainedInterruptRequestTurnItems(
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
      message.delegatedCompletion !== undefined ||
      // Keep the workflow script outside the history window; clients use it to open the coordinator thread.
      message.workflowScript === true,
  );
}

/** Watermark prevents old missing updates from appending newest when bounded windows lack local rows. */
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

export function buildBoundedThreadProjection(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
}): BoundedProjectionResult {
  const policy = input.policy ?? THREAD_HISTORY_PAGE_POLICY;
  const threadId = input.projection.thread.id;
  const runOrdinals = new Map(input.projection.runs.map((run) => [run.id, run.ordinal]));
  let latestTodoList: (typeof input.projection.plans)[number] | undefined;
  let latestTodoListOrdinal = -1;
  for (const plan of input.projection.plans) {
    const ordinal = plan.runId === null ? undefined : runOrdinals.get(plan.runId);
    if (
      plan.kind === "todo_list" &&
      plan.status !== "superseded" &&
      ordinal !== undefined &&
      ordinal >= latestTodoListOrdinal
    ) {
      latestTodoList = plan;
      latestTodoListOrdinal = ordinal;
    }
  }
  const controlProjection = {
    ...input.projection,
    plans: input.projection.plans.filter(
      (plan) => plan.status === "active" || plan.id === latestTodoList?.id,
    ),
    contextHandoffs: input.projection.contextHandoffs.filter(
      (handoff) => handoff.status === "pending" || handoff.status === "ready",
    ),
  };
  const latestLocalTurnOrdinal = computeLatestLocalTurnOrdinal(input.projection.turnItems);

  const dependencyReserve = (() => {
    let reserve = 0;
    for (const item of controlProjection.turnItems) {
      if (item.type === "run_interrupt_request") {
        reserve += bytesOfJson(item);
      }
    }
    return reserve;
  })();
  const controlBytes = bytesOfJson({
    ...controlProjection,
    messages: [],
    turnItems: [],
    visibleTurnItems: [],
  });
  // Control state (checkpoint file lists, the latest task list) cannot be paged, so it may claim at most
  // half the budget; past that the window would shrink to the one row every page admits.
  const windowBudget = Math.max(
    policy.maxEncodedBytes / 2,
    policy.maxEncodedBytes - dependencyReserve - controlBytes - 1_024,
  );
  const windowPolicy: ThreadHistoryPagePolicy = { ...policy, maxEncodedBytes: windowBudget };

  const window = selectRecentTimelineWindow({
    items: controlProjection.visibleTurnItems,
    snapshotSequence: input.snapshotSequence,
    policy: windowPolicy,
    rowEncodedBytes: (row) => projectedRowBoundedSnapshotEncodedBytes(row, threadId),
  });
  const visibleTurnItems = renumberPositions(window.items);
  const windowTurnItems = localTurnItemsForVisibleWindow(controlProjection, visibleTurnItems);
  const dependencyTurnItems = retainedInterruptRequestTurnItems(
    controlProjection,
    visibleTurnItems,
  );
  const turnItemById = new Map<string, OrchestrationV2TurnItem>();
  for (const item of windowTurnItems) {
    turnItemById.set(String(item.id), item);
  }
  for (const item of dependencyTurnItems) {
    turnItemById.set(String(item.id), item);
  }
  const turnItems = [...turnItemById.values()];

  const visiblePlanIds = new Set(
    turnItems.flatMap((item) =>
      item.type === "proposed_plan" || item.type === "todo_list" ? [String(item.planId)] : [],
    ),
  );
  const visibleHandoffIds = new Set(
    turnItems.flatMap((item) => (item.type === "handoff" ? [String(item.contextHandoffId)] : [])),
  );
  const plans = input.projection.plans
    .filter(
      (plan) =>
        plan.status === "active" ||
        plan.id === latestTodoList?.id ||
        visiblePlanIds.has(String(plan.id)),
    )
    .map((plan) =>
      plan.status === "active" || plan.id === latestTodoList?.id
        ? plan
        : plan.kind === "proposed_plan"
          ? { ...plan, markdown: "", detailInTurnItem: true as const }
          : { ...plan, explanation: undefined, detailInTurnItem: true as const },
    );
  const contextHandoffs = input.projection.contextHandoffs
    .filter(
      (handoff) =>
        handoff.status === "pending" ||
        handoff.status === "ready" ||
        visibleHandoffIds.has(String(handoff.id)),
    )
    .map((handoff) =>
      handoff.status === "pending" || handoff.status === "ready"
        ? handoff
        : { ...handoff, summaryText: "", detailInTurnItem: true as const },
    );

  const projection = {
    ...controlProjection,
    plans,
    contextHandoffs,
    messages: messagesForBoundedProjection(controlProjection, turnItems),
    turnItems,
    visibleTurnItems,
  };
  return {
    projection,
    historyCursor: window.nextCursor,
    hasMoreHistory: window.hasMoreHistory,
    latestLocalTurnOrdinal,
  };
}
