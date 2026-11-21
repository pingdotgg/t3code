import type {
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";

import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import {
  mergeOlderHistoryIntoProjection,
  mergeOlderSubagentsIntoProjection,
} from "./threadHistoryMerge.ts";

/**
 * A thread built from its stream alone, for a view with no environment connection of its own to
 * the thread: a guest page, or a linked environment's thread read through the link.
 */
export interface ThreadStreamState {
  /** The thread as the owner's client holds it, built with the same reducer. */
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly sequence: number;
  /** Set while the snapshot is a window of a longer history, as the owner's client tracks it. */
  readonly partial: { readonly latestLocalTurnOrdinal: number | null } | null;
  /** Where "Load earlier turns" continues, or null once the whole thread is loaded. */
  readonly historyCursor: string | null;
}

export const initialThreadStreamState: ThreadStreamState = {
  projection: null,
  sequence: 0,
  partial: null,
  historyCursor: null,
};

/**
 * Applies the owner's thread stream the way the owner's client does (see EnvironmentThreadState):
 * a snapshot replaces the thread, and later events pass through the same projection reducer, once
 * each.
 */
export function applyThreadStreamItem(
  state: ThreadStreamState,
  item: OrchestrationV2ThreadStreamItem,
): ThreadStreamState {
  if (item.kind === "snapshot") {
    return {
      projection: boundedSnapshotProjection(item),
      sequence: item.snapshotSequence,
      partial:
        item.hasMoreHistory === true || (item.historyCursor ?? null) !== null
          ? { latestLocalTurnOrdinal: item.latestLocalTurnOrdinal ?? null }
          : null,
      historyCursor: item.hasMoreHistory === true ? (item.historyCursor ?? null) : null,
    };
  }
  if (item.kind === "synchronized" || item.sequence <= state.sequence) return state;
  if (item.kind === "unknown-event") return { ...state, sequence: item.sequence };
  const projection =
    applyOrchestrationV2ProjectionEvent(
      state.projection,
      item.event,
      state.partial === null ? undefined : { partialTimeline: true, ...state.partial },
    ) ?? state.projection;
  const turnItem = item.event.type === "turn-item.updated" ? item.event.payload : null;
  const watermark = state.partial?.latestLocalTurnOrdinal ?? null;
  return {
    ...state,
    projection,
    sequence: item.sequence,
    partial:
      state.partial !== null &&
      turnItem !== null &&
      (watermark === null || turnItem.ordinal > watermark)
        ? { latestLocalTurnOrdinal: turnItem.ordinal }
        : state.partial,
  };
}

/** Merges a page of older turns, fetched from `cursor`, in front, as in the owner's view. */
export function applyThreadHistoryPage(
  state: ThreadStreamState,
  cursor: string,
  page: OrchestrationV2ThreadHistoryPage,
): ThreadStreamState {
  // A snapshot since the request replaced the thread and its cursor.
  if (state.projection === null || state.historyCursor !== cursor) return state;
  return {
    ...state,
    projection: mergeOlderSubagentsIntoProjection(
      mergeOlderHistoryIntoProjection(state.projection, page.items),
      page.subagents,
    ),
    historyCursor: page.hasMoreHistory ? page.nextCursor : null,
  };
}
