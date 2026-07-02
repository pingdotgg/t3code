import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { liveWindowOldestActivityId, oldestActivityByChronology } from "./threadReducer.ts";

const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];

/**
 * Pagination cursor for a thread's older activities. Sequenced rows page by
 * `beforeSequence`; legacy/unsequenced rows (the common case — `sequence` is
 * absent on most real rows) page by the `(createdAt, activityId)` keyset.
 */
export type OlderActivitiesCursor =
  | { readonly beforeSequence: number }
  | {
      readonly beforeCreatedAt: OrchestrationThreadActivity["createdAt"];
      readonly beforeActivityId: OrchestrationThreadActivity["id"];
    };

export interface OlderActivitiesPage {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly hasMore: boolean;
}

export interface UseOlderThreadActivitiesOptions {
  /**
   * Identity of the thread the live window belongs to (e.g.
   * `${environmentId}\0${threadId}`); null when no thread is selected.
   * Changing it resets the lazy-loaded pages.
   */
  readonly threadKey: string | null;
  /** The server-windowed live activity set from the thread detail. */
  readonly liveActivities: ReadonlyArray<OrchestrationThreadActivity>;
  /** The server's `hasMoreActivities` flag from the detail snapshot. */
  readonly hasMoreLiveActivities: boolean;
  /**
   * Fetch the page immediately older than the cursor. Resolve `null` to skip
   * the page silently (a failure the caller already surfaced, or an
   * interrupted command) — `hasMore` is left true so the user can retry.
   * MUST be referentially stable (useCallback) for the load callback to be.
   */
  readonly loadPage: (cursor: OlderActivitiesCursor) => Promise<OlderActivitiesPage | null>;
}

export interface UseOlderThreadActivitiesResult {
  /** Lazy-loaded older pages + the live window, oldest first. */
  readonly mergedActivities: ReadonlyArray<OrchestrationThreadActivity>;
  /** Whether older history exists beyond everything loaded. */
  readonly hasMoreOlder: boolean;
  readonly loadingOlder: boolean;
  /** Dispatch a load of the next older page (no-op while one is in flight). */
  readonly loadOlder: () => void;
}

// ── Pure decision kernel (exported for unit tests) ──────────────────────────

export interface LiveWindowShape {
  readonly key: string | null;
  /** Chronological-oldest activity id (an identity sentinel, not a lookup key). */
  readonly oldest: string | null;
  readonly count: number;
}

/**
 * Whether the live window was RESHAPED rather than purely appended-to: a
 * different thread, a re-snapshot (reconnect) that changes the window's
 * chronological-oldest row, or a checkpoint revert that shrinks it. A pure
 * append (same thread, same oldest, count not smaller) is NOT a reshape.
 */
export function didLiveWindowReshape(previous: LiveWindowShape, next: LiveWindowShape): boolean {
  return (
    next.key !== previous.key || next.oldest !== previous.oldest || next.count < previous.count
  );
}

/**
 * The cursor for the page immediately older than `oldest`: sequenced rows page
 * by `beforeSequence`; unsequenced rows (the common case) by the
 * `(createdAt, activityId)` keyset.
 */
export function olderActivitiesCursorFor(
  oldest: OrchestrationThreadActivity,
): OlderActivitiesCursor {
  return oldest.sequence !== undefined
    ? { beforeSequence: oldest.sequence }
    : { beforeCreatedAt: oldest.createdAt, beforeActivityId: oldest.id };
}

/**
 * The row the NEXT load should cursor from: the explicit cursor row already
 * paged past when one exists (so an all-overlap page keeps advancing), else
 * the chronologically-oldest loaded row — never index 0, which the reducer
 * can fill with a newer row (unsequenced rows sort to the end).
 */
export function nextOlderActivitiesCursorRow(
  pagedPast: OrchestrationThreadActivity | null,
  merged: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity | null {
  return pagedPast ?? oldestActivityByChronology(merged);
}

/**
 * The page rows not already present in the loaded set (older pages + live
 * window) — boundary overlap and mid-flight appends must never produce
 * duplicate ids in the merged timeline.
 */
export function freshOlderActivities(
  page: OlderActivitiesPage,
  merged: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const seen = new Set(merged.map((activity) => activity.id));
  return page.activities.filter((activity) => !seen.has(activity.id));
}

/**
 * The older-history lazy-load engine, shared by every client (web ChatView,
 * the mobile composer, the TUI ChatView). The thread-detail snapshot windows
 * activities to the most recent page; older pages are fetched on demand and
 * prepended.
 *
 * One implementation holds all the hardening the per-client copies kept
 * drifting on:
 * - reset on live-window RESHAPE, not just thread switch: a reconnect
 *   re-snapshot changes the window's chronological-oldest row and a checkpoint
 *   revert shrinks it, but a plain append does neither (the reducer re-sorts
 *   unsequenced rows, so index 0 is not a stable boundary — the sentinel is
 *   {@link liveWindowOldestActivityId});
 * - a generation guard so a load resolving after a reset can't repopulate the
 *   cleared state;
 * - a synchronous in-flight key so scroll-triggered duplicate dispatches
 *   coalesce before the loading state commits;
 * - an explicit advancing cursor (the oldest row paged PAST), so an
 *   all-overlap page keeps paging instead of dead-ending while the server
 *   still reports more — the server cursor is strict, so it strictly
 *   decreases and paging cannot loop;
 * - dedup against the LATEST merged set via a ref, so a live append or a
 *   prior prepend settling mid-flight can't produce duplicate ids;
 * - `hasMore` stays true on a failed/skipped page (the history still exists;
 *   scrolling back retries).
 */
export function useOlderThreadActivities(
  options: UseOlderThreadActivitiesOptions,
): UseOlderThreadActivitiesResult {
  const { threadKey, liveActivities, hasMoreLiveActivities, loadPage } = options;

  const [olderActivities, setOlderActivities] = useState<
    ReadonlyArray<OrchestrationThreadActivity>
  >([]);
  const [olderLoaded, setOlderLoaded] = useState(false);
  const [olderHasMore, setOlderHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Order-independent oldest boundary: `liveActivities[0]` shifts when the
  // reducer re-sorts unsequenced rows on the first live append, which would
  // otherwise make a plain append look like a window reshape.
  const liveOldestActivityId = useMemo(
    () => liveWindowOldestActivityId(liveActivities),
    [liveActivities],
  );
  const liveActivityCount = liveActivities.length;

  // Bumps on every reset so a late in-flight load can't repopulate the
  // freshly-cleared state (the thread key alone doesn't change on a
  // same-thread window reshape).
  const generationRef = useRef(0);
  // The thread key of an in-flight load — coalesces the duplicate dispatches a
  // fast scroll fires before the loading state updates.
  const inFlightKeyRef = useRef<string | null>(null);
  // The oldest row we've paged past; advances even when a page dedupes to
  // nothing. Reset on reshape.
  const cursorRef = useRef<OrchestrationThreadActivity | null>(null);
  const windowRef = useRef({
    key: threadKey,
    oldest: liveOldestActivityId,
    count: liveActivityCount,
  });

  // useLayoutEffect (not useEffect) so the cleared state commits before paint:
  // otherwise a thread switch renders one frame with the previous thread's
  // lazy-loaded pages still merged in, flashing stale rows.
  useLayoutEffect(() => {
    const previous = windowRef.current;
    windowRef.current = {
      key: threadKey,
      oldest: liveOldestActivityId,
      count: liveActivityCount,
    };
    if (!didLiveWindowReshape(previous, windowRef.current)) {
      return;
    }
    generationRef.current += 1;
    inFlightKeyRef.current = null;
    cursorRef.current = null;
    setOlderActivities([]);
    setOlderLoaded(false);
    setOlderHasMore(false);
    setLoadingOlder(false);
  }, [threadKey, liveOldestActivityId, liveActivityCount]);

  const mergedActivities = useMemo(
    () =>
      olderActivities.length > 0 ? [...olderActivities, ...liveActivities] : liveActivities,
    [olderActivities, liveActivities],
  );
  // Latest merged set, read inside the async load handler so dedup runs
  // against current state, not the snapshot captured at dispatch time.
  const mergedActivitiesRef = useRef(mergedActivities);
  mergedActivitiesRef.current = mergedActivities;

  // Before any page is loaded the server flag is authoritative; afterwards
  // the latest page's `hasMore` is.
  const hasMoreOlder = olderLoaded
    ? olderHasMore
    : threadKey !== null && hasMoreLiveActivities;

  const loadOlder = useCallback(() => {
    if (threadKey === null || !hasMoreOlder) {
      return;
    }
    const oldest = nextOlderActivitiesCursorRow(cursorRef.current, mergedActivitiesRef.current);
    if (!oldest) {
      return;
    }
    if (inFlightKeyRef.current === threadKey) {
      return; // a load for this thread is already in flight
    }
    const cursor = olderActivitiesCursorFor(oldest);
    const generation = generationRef.current;
    inFlightKeyRef.current = threadKey;
    setLoadingOlder(true);
    void loadPage(cursor)
      .then((page) => {
        // The window/thread was reset while this was in flight — drop the page
        // so it can't repopulate state cleared by the reset.
        if (generationRef.current !== generation) {
          return;
        }
        if (page === null) {
          // Failed or interrupted (already surfaced by the caller). Keep
          // `hasMore` — the history still exists and retrying is valid.
          return;
        }
        // Advance the cursor even when every row dedupes away — the server
        // cursor is strict, so it strictly decreases and paging can't loop.
        const pageOldest = page.activities[0];
        if (pageOldest) {
          cursorRef.current = pageOldest;
        }
        const fresh = freshOlderActivities(page, mergedActivitiesRef.current);
        if (fresh.length > 0) {
          setOlderActivities((previous) => [...fresh, ...previous]);
        }
        setOlderLoaded(true);
        setOlderHasMore(page.hasMore);
      })
      .finally(() => {
        if (generationRef.current === generation) {
          inFlightKeyRef.current = null;
          setLoadingOlder(false);
        }
      });
  }, [threadKey, hasMoreOlder, loadPage]);

  return {
    mergedActivities: threadKey === null ? EMPTY_ACTIVITIES : mergedActivities,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
  };
}
