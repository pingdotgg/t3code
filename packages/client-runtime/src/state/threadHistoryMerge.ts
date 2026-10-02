import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { isOrchestrationV2TurnItemVisible } from "@t3tools/shared/orchestrationV2Timeline";

export type ThreadHistoryMeta = {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  /** True after at least one older page was merged; skip monolithic cache growth. */
  readonly expanded: boolean;
  /**
   * Max local turn ordinal known for partial progressive windows. Null when
   * unknown (legacy cache) or when history meta is cleared for a full snapshot.
   */
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

/** Whether a history-page response still matches the cursor that started it. */
export function isActiveHistoryRequestCursor(
  requestCursor: string,
  history: { readonly historyCursor: string | null },
): boolean {
  return history.historyCursor === requestCursor;
}

/**
 * Clear history loading after an interrupted load-earlier only when the
 * request cursor is still active. Does not touch stream/status/error.
 */
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

function renumberVisible(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ProjectedTurnItem[] {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position }));
}

/**
 * Merge an older history page into the live projection. Dedupes by
 * sourceThreadId + sourceItemId, keeps chronological order (older first), and
 * preserves newer live rows already present in state.
 */
export function mergeOlderHistoryIntoProjection(
  projection: OrchestrationV2ThreadProjection,
  olderItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ThreadProjection {
  if (olderItems.length === 0) {
    return projection;
  }

  const existingKeys = new Set(projection.visibleTurnItems.map(projectedItemKey));
  const turnItemById = new Map<string, OrchestrationV2TurnItem>();
  for (const item of projection.turnItems) {
    turnItemById.set(String(item.id), item);
  }
  const prepended: OrchestrationV2ProjectedTurnItem[] = [];
  for (const pageRow of olderItems) {
    let row = pageRow;
    const key = projectedItemKey(row);
    if (existingKeys.has(key)) {
      continue;
    }
    if (row.visibility === "local" || row.sourceThreadId === projection.thread.id) {
      const currentItem = turnItemById.get(String(row.sourceItemId));
      if (currentItem !== undefined) {
        // A live event may have hidden this item while the page was in flight.
        // Do not resurrect the stale page copy. Retained interrupt requests are
        // the exception: they intentionally exist outside the bounded visible
        // window and should become visible when their history page arrives.
        if (currentItem.type !== "run_interrupt_request") {
          continue;
        }
        if (
          !isOrchestrationV2TurnItemVisible({
            item: currentItem,
            runs: projection.runs,
            attempts: projection.attempts,
            items: projection.turnItems,
          })
        ) {
          continue;
        }
        row = { ...row, item: currentItem };
      }
    }
    existingKeys.add(key);
    prepended.push(row);
  }
  if (prepended.length === 0) {
    return projection;
  }

  const visibleTurnItems = renumberVisible([...prepended, ...projection.visibleTurnItems]);

  for (const row of prepended) {
    if (row.visibility === "local" || row.sourceThreadId === projection.thread.id) {
      if (!turnItemById.has(String(row.sourceItemId))) {
        turnItemById.set(String(row.sourceItemId), row.item);
      }
    }
  }

  return {
    ...projection,
    turnItems: [...turnItemById.values()],
    visibleTurnItems,
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
    // Preserve the partial-timeline watermark across load-earlier pages.
    latestLocalTurnOrdinal: current.latestLocalTurnOrdinal,
  };
}

/** Whether a client timeline should render its load-earlier control. */
export function shouldShowLoadEarlierControl(history: ThreadHistoryMeta): boolean {
  return history.hasMoreHistory || history.error !== null;
}
