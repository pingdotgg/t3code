import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";
import {
  countViewedFiles,
  isFileViewed,
  isStaleViewedState,
  revertFileViewedOverlay,
  settleFileViewedOverlay,
  toFileViewedBatch,
  toFileViewedStates,
  type FileViewedOverlay,
} from "./pullRequestFilesViewed.logic";

/**
 * How long presses gather before the host is told. Long enough that ticking down a file list
 * costs one request rather than one per file, short enough that a reader who ticks one file and
 * closes the tab has already been recorded.
 */
const FLUSH_DELAY_MS = 400;

const NO_OVERLAY: FileViewedOverlay = new Map();

export interface PullRequestFilesViewedView {
  /** Whether the host tracks this at all, which is what hides the whole control. */
  readonly enabled: boolean;
  readonly isViewed: (path: string) => boolean;
  /** The host says this file has been pushed to since it was cleared. */
  readonly isStale: (path: string) => boolean;
  readonly setViewed: (path: string, viewed: boolean) => void;
  /** How many of the files on screen are ticked off. */
  readonly viewedCount: number;
  /** The host had more files than the read covered, so the count above may be short. */
  readonly truncated: boolean;
}

/**
 * Which files this reader has already cleared, as the host records it.
 *
 * The state lives on the host rather than here so a review carried on from another machine, or
 * from the host's own web UI, picks up where it was left. Presses show immediately and are held
 * over the host's answer until it agrees with them, so the checkbox never waits on a round trip.
 */
export function usePullRequestFilesViewed(options: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly enabled: boolean;
  /** The paths on screen, which is what the counter counts. */
  readonly paths: ReadonlyArray<string>;
}): PullRequestFilesViewedView {
  const { environmentId, reference, enabled, paths } = options;
  const query = useEnvironmentQuery(
    enabled ? pullRequestEnvironment.filesViewed({ environmentId, input: reference }) : null,
  );
  const refresh = query.refresh;
  const states = useMemo(() => toFileViewedStates(query.data), [query.data]);
  const truncated = query.data?.truncated === true;
  const [overlay, setOverlay] = useState<FileViewedOverlay>(NO_OVERLAY);
  const setFilesViewed = useAtomCommand(pullRequestEnvironment.setFilesViewed);

  // Presses waiting for the next flush, and, for every path a request is already carrying, which
  // request that is. Requests overlap and run in the order they were made, so a path pressed
  // again while an earlier one is still out belongs to the later request from that moment on, and
  // the earlier one stops answering for it. Both are refs rather than state: nothing on screen
  // reads them, and the flush must see the latest.
  const queued = useRef<Map<string, boolean>>(new Map());
  const sentBy = useRef<Map<string, number>>(new Map());
  const requests = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Everything held here belongs to one change request on one environment. The environment is
  // part of that: two of them can hand out the same project id, and a press made against one
  // must never be answered for by the other.
  const scopeKey = `${environmentId} ${reference.projectId} ${reference.repository} ${reference.number}`;
  const scope = useRef(scopeKey);

  useEffect(() => {
    setOverlay((current) =>
      settleFileViewedOverlay(
        current,
        states,
        new Set([...queued.current.keys(), ...sentBy.current.keys()]),
      ),
    );
  }, [states]);

  const flush = useCallback(() => {
    flushTimer.current = null;
    const batch = toFileViewedBatch(queued.current);
    if (batch.length === 0) return;
    queued.current = new Map();
    const sentFrom = scope.current;
    const request = ++requests.current;
    for (const file of batch) sentBy.current.set(file.path, request);
    void setFilesViewed({ environmentId, input: { ...reference, files: batch } }).then((result) => {
      const mine = batch
        .map((file) => file.path)
        .filter((path) => sentBy.current.get(path) === request);
      for (const path of mine) sentBy.current.delete(path);
      // The reader has moved to another change request, or another environment, and what is on
      // screen now has nothing to do with this answer.
      if (scope.current !== sentFrom) return;
      if (result._tag === "Failure") {
        // The host never heard these, so the ticks go back to whatever it last said. Only the
        // paths this request still answers for: one pressed again since is waiting on a request
        // of its own, or on the next flush, and that press is the one on screen.
        const owned = new Set(mine.filter((path) => !queued.current.has(path)));
        setOverlay((current) => revertFileViewedOverlay(current, batch, owned));
        toastManager.add({ type: "error", title: "Could not update viewed files" });
        return;
      }
      refresh();
    });
  }, [environmentId, reference, refresh, setFilesViewed]);

  // Read through a ref rather than closed over: `setViewed` is handed to every file header the
  // viewer draws, and a new identity per render would rebuild all of them.
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Leaving a change request, the environment it lives on, or the page itself records what was
  // pressed and then drops the rest. The flush kept here is the one bound to the scope being
  // left, which is what sends those last presses where they were meant to go.
  useEffect(() => {
    const flushScope = flushRef.current;
    scope.current = scopeKey;
    return () => {
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current);
        flushScope();
      }
      queued.current = new Map();
      sentBy.current = new Map();
      setOverlay(NO_OVERLAY);
    };
  }, [scopeKey]);

  const setViewed = useCallback((path: string, viewed: boolean) => {
    setOverlay((current) => new Map(current).set(path, viewed));
    queued.current.set(path, viewed);
    if (flushTimer.current !== null) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => flushRef.current(), FLUSH_DELAY_MS);
  }, []);

  const isViewed = useCallback(
    (path: string) => isFileViewed(path, states, overlay),
    [overlay, states],
  );
  const isStale = useCallback(
    (path: string) => !overlay.has(path) && isStaleViewedState(states?.get(path)),
    [overlay, states],
  );
  const viewedCount = useMemo(
    () => countViewedFiles(paths, states, overlay),
    [overlay, paths, states],
  );

  // One identity per change of what it says: the viewer keys every file it draws off this, and a
  // fresh object each render would redraw the whole diff.
  return useMemo(
    () => ({ enabled, isViewed, isStale, setViewed, viewedCount, truncated }),
    [enabled, isStale, isViewed, setViewed, truncated, viewedCount],
  );
}
