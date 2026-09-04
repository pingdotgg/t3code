import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
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
  /** Whether anything remembers this at all, which is what hides the whole control. */
  readonly enabled: boolean;
  readonly isViewed: (path: string) => boolean;
  /** This file has been pushed to since it was cleared. */
  readonly isStale: (path: string) => boolean;
  readonly setViewed: (path: string, viewed: boolean) => void;
  /** How many of the files on screen are ticked off. */
  readonly viewedCount: number;
  /** The host had more files than the read covered, so the count above may be short. */
  readonly truncated: boolean;
  /**
   * Re-ask the host. The page's refresh button goes around the host's cache, and the ticks and
   * the marks beside them are part of what the reader asked to be shown again.
   */
  readonly refresh: () => void;
}

/**
 * Which files this reader has already cleared.
 *
 * The marks live on the server rather than in this tab, so a review carried on from another
 * machine picks up where it was left. Where the host keeps a record of its own, those are the
 * marks, and its web UI shows the same ones; where it does not, the environment keeps them and
 * says so. Presses show immediately and are held over the server's answer until it agrees with
 * them, so the checkbox never waits on a round trip.
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
  const setFilesViewed = useAtomCommand(pullRequestEnvironment.setFilesViewed, {
    reportFailure: false,
  });

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
        // Two silences here. Nothing was still this request's to answer for, so nothing on
        // screen went back and a later press is the one that gets to speak for these paths. Or
        // the connection went away mid-flight, which the reader is already being told about and
        // which the host never refused.
        if (owned.size > 0 && !isAtomCommandInterrupted(result)) {
          toastManager.add({ type: "error", title: "Could not update viewed files" });
        }
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

  // Held through a ref for the same reason `setViewed` is: it goes into the view object below,
  // which every file header keys off, so it has to keep one identity for the tab's life.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const refreshFromHost = useCallback(() => refreshRef.current(), []);

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
    () => ({
      enabled,
      isViewed,
      isStale,
      setViewed,
      viewedCount,
      truncated,
      refresh: refreshFromHost,
    }),
    [enabled, isStale, isViewed, refreshFromHost, setViewed, truncated, viewedCount],
  );
}
