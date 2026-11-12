import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { isOrchestrationV2TurnItemVisible } from "@t3tools/shared/orchestrationV2Timeline";

export type ThreadHistoryMeta = {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly expanded: boolean;
  readonly latestLocalTurnOrdinal: number | null;
};

export const EMPTY_THREAD_HISTORY_META: ThreadHistoryMeta = {
  historyCursor: null,
  hasMoreHistory: false,
  loading: false,
  error: null,
  expanded: false,
  latestLocalTurnOrdinal: null,
};

export function isActiveHistoryRequestCursor(
  requestCursor: string,
  history: { readonly historyCursor: string | null },
): boolean {
  return history.historyCursor === requestCursor;
}

export function clearActiveHistoryLoading(
  requestCursor: string,
  history: ThreadHistoryMeta,
): ThreadHistoryMeta {
  if (!isActiveHistoryRequestCursor(requestCursor, history) || !history.loading) {
    return history;
  }
  return { ...history, loading: false };
}

function projectedItemKey(row: OrchestrationV2ProjectedTurnItem): string {
  return `${row.sourceThreadId}:${row.sourceItemId}`;
}

// Same order as the server's `ORDER BY ordinal, turn_item_id` (binary collation).
function compareByOrdinalThenId(
  left: OrchestrationV2ProjectedTurnItem,
  right: OrchestrationV2ProjectedTurnItem,
): number {
  if (left.item.ordinal !== right.item.ordinal) return left.item.ordinal - right.item.ordinal;
  return left.item.id < right.item.id ? -1 : left.item.id > right.item.id ? 1 : 0;
}

function renumberVisible(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ProjectedTurnItem[] {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position }));
}

// Inherited and local rows can share a sourceItemId; the local row owns the deferred work.
export function findDeferredWorkAnchorIndex(
  projection: OrchestrationV2ThreadProjection,
  anchorId: string,
): number {
  const rows = projection.visibleTurnItems;
  const local = rows.findIndex(
    (row) =>
      row.sourceItemId === anchorId &&
      (row.visibility === "local" || row.sourceThreadId === projection.thread.id),
  );
  return local !== -1 ? local : rows.findIndex((row) => row.sourceItemId === anchorId);
}

export function mergeOlderHistoryIntoProjection(
  projection: OrchestrationV2ThreadProjection,
  olderItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  work?: { readonly anchorId: string; readonly nextCursor: string | null },
): OrchestrationV2ThreadProjection {
  if (olderItems.length === 0 && work === undefined) {
    return projection;
  }

  const start = work === undefined ? -1 : findDeferredWorkAnchorIndex(projection, work.anchorId);
  const anchor = projection.visibleTurnItems[start];
  const deferred = anchor?.item.deferredWork;
  if (work !== undefined && deferred === undefined) return projection;
  const currentByKey = new Map(
    projection.visibleTurnItems.map((row) => [projectedItemKey(row), row]),
  );
  const turnItemById = new Map(projection.turnItems.map((item) => [String(item.id), item]));
  const pageKeys = new Set<string>();
  const page: OrchestrationV2ProjectedTurnItem[] = [];
  for (const pageRow of olderItems) {
    if (
      work &&
      anchor &&
      deferred &&
      (pageRow.sourceThreadId !== anchor.sourceThreadId ||
        pageRow.item.ordinal < anchor.item.ordinal ||
        pageRow.item.ordinal > deferred.lastOrdinal)
    )
      continue;
    const key = projectedItemKey(pageRow);
    if (pageKeys.has(key)) continue;
    let row = currentByKey.get(key) ?? pageRow;
    if (
      !currentByKey.has(key) &&
      (row.visibility === "local" || row.sourceThreadId === projection.thread.id)
    ) {
      const currentItem = turnItemById.get(String(row.sourceItemId));
      // Hidden live items stay hidden. Snapshots also retain interrupt requests and
      // pending request cards outside the visible window; their history page shows them.
      if (currentItem !== undefined) {
        if (
          (currentItem.type !== "run_interrupt_request" &&
            currentItem.type !== "approval_request" &&
            currentItem.type !== "user_input_request") ||
          !isOrchestrationV2TurnItemVisible({
            item: currentItem,
            runs: projection.runs,
            attempts: projection.attempts,
            items: projection.turnItems,
          })
        )
          continue;
        row = { ...row, item: currentItem };
      }
    }
    pageKeys.add(key);
    page.push(row);
    if (
      (row.visibility === "local" || row.sourceThreadId === projection.thread.id) &&
      !turnItemById.has(String(row.sourceItemId))
    )
      turnItemById.set(String(row.sourceItemId), row.item);
  }
  if (page.length === 0 && work === undefined) return projection;
  let visible: OrchestrationV2ProjectedTurnItem[];
  if (work && anchor && deferred) {
    let end = start + 1;
    while (end < projection.visibleTurnItems.length) {
      const row = projection.visibleTurnItems[end]!;
      if (
        row.sourceThreadId !== anchor.sourceThreadId ||
        row.visibility === "synthetic" ||
        row.item.ordinal > deferred.lastOrdinal
      )
        break;
      end += 1;
    }
    const item = { ...anchor.item };
    if (work.nextCursor === null) delete item.deferredWork;
    else item.deferredWork = { ...deferred, cursor: work.nextCursor };
    const updated = { ...anchor, item };
    const section = [
      ...page,
      ...projection.visibleTurnItems
        .slice(start, end)
        .filter((row) => !pageKeys.has(projectedItemKey(row))),
    ];
    const ordered = section
      .map((row) => (projectedItemKey(row) === projectedItemKey(updated) ? updated : row))
      .sort(compareByOrdinalThenId);
    visible = [
      ...projection.visibleTurnItems.slice(0, start),
      ...ordered,
      ...projection.visibleTurnItems.slice(end),
    ];
    if (anchor.visibility === "local") turnItemById.set(String(updated.item.id), updated.item);
  } else {
    visible = [
      ...page,
      ...projection.visibleTurnItems.filter((row) => !pageKeys.has(projectedItemKey(row))),
    ];
  }
  if (
    visible.length === projection.visibleTurnItems.length &&
    visible.every((row, index) => row === projection.visibleTurnItems[index])
  )
    return projection;
  return {
    ...projection,
    turnItems: [...turnItemById.values()],
    visibleTurnItems: renumberVisible(visible),
  };
}

export function applyHistoryPageMeta(
  current: ThreadHistoryMeta,
  page: {
    readonly nextCursor: string | null;
    readonly hasMoreHistory: boolean;
  },
): ThreadHistoryMeta {
  return {
    historyCursor: page.nextCursor,
    hasMoreHistory: page.hasMoreHistory,
    loading: false,
    error: null,
    expanded: true,
    latestLocalTurnOrdinal: current.latestLocalTurnOrdinal,
  };
}

export function shouldShowLoadEarlierControl(history: ThreadHistoryMeta): boolean {
  return history.hasMoreHistory || history.error !== null;
}
