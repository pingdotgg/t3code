import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useStableCallback } from "~/hooks/useStableCallback";

import { toastManager } from "../ui/toast";
import {
  isFileViewed,
  isStaleViewedState,
  revertFileViewedOverlay,
  settleFileViewedOverlay,
  toFileViewedBatch,
  toFileViewedStates,
  type FileViewedOverlay,
  type FileViewedStates,
} from "./pullRequestFilesViewed.logic";

const FLUSH_DELAY_MS = 400;

const NO_OVERLAY: FileViewedOverlay = new Map();

export interface PullRequestFilesViewedView {
  readonly enabled: boolean;
  readonly isViewed: (path: string) => boolean;
  readonly isStale: (path: string) => boolean;
  readonly setViewed: (path: string, viewed: boolean) => void;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

export function usePullRequestFilesViewed(options: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly enabled: boolean;
}): PullRequestFilesViewedView {
  const { environmentId, reference, enabled } = options;
  const query = useEnvironmentQuery(
    enabled ? pullRequestEnvironment.filesViewed({ environmentId, input: reference }) : null,
  );
  const refresh = query.refresh;
  const states = toFileViewedStates(query.data);
  const truncated = query.data?.truncated === true;
  const error = query.error;
  const [overlay, setOverlay] = useState<FileViewedOverlay>(NO_OVERLAY);
  const setFilesViewed = useAtomCommand(pullRequestEnvironment.setFilesViewed, {
    reportFailure: false,
  });

  const queued = useRef<Map<string, boolean>>(new Map());
  const sentBy = useRef<Map<string, number>>(new Map());
  const requests = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Project ids can repeat across environments.
  const scopeKey = `${environmentId} ${reference.projectId} ${reference.repository} ${reference.number}`;
  const scope = useRef(scopeKey);

  // Retire presses only after a post-write read, even if an older response agrees.
  const answeredFrom = useRef<Map<string, FileViewedStates | null>>(new Map());
  const committedStates = useRef(states);

  useEffect(() => {
    committedStates.current = states;
    const pending = new Set([...queued.current.keys(), ...sentBy.current.keys()]);
    const answered = new Set<string>();
    for (const [path, from] of answeredFrom.current) {
      if (pending.has(path) || from === states) continue;
      answered.add(path);
      answeredFrom.current.delete(path);
    }
    setOverlay((current) => settleFileViewedOverlay(current, states, pending, answered));
  }, [states]);

  // Explicit targets keep departing scopes' presses in their original scope.
  const flush = (target: {
    readonly environmentId: EnvironmentId;
    readonly reference: PullRequestRef;
  }) => {
    flushTimer.current = null;
    const batch = toFileViewedBatch(queued.current);
    if (batch.length === 0) return;
    queued.current = new Map();
    const sentFrom = scope.current;
    const request = ++requests.current;
    for (const file of batch) sentBy.current.set(file.path, request);
    void setFilesViewed({
      environmentId: target.environmentId,
      input: { ...target.reference, files: batch },
    }).then((result) => {
      const mine = batch
        .map((file) => file.path)
        .filter((path) => sentBy.current.get(path) === request);
      for (const path of mine) sentBy.current.delete(path);
      if (scope.current !== sentFrom) return;
      if (result._tag === "Failure") {
        const owned = new Set(mine.filter((path) => !queued.current.has(path)));
        setOverlay((current) => revertFileViewedOverlay(current, batch, owned));
        if (owned.size > 0 && !isAtomCommandInterrupted(result)) {
          toastManager.add({ type: "error", title: "Could not update viewed files" });
          refresh();
        }
        return;
      }
      // The next read can report dismissed after a push; retire presses regardless of its value.
      for (const path of mine) answeredFrom.current.set(path, committedStates.current);
      refresh();
    });
  };

  const currentTarget = useEffectEvent(() => ({ environmentId, reference }));
  const flushTarget = useEffectEvent(flush);

  useEffect(() => {
    const leaving = currentTarget();
    scope.current = scopeKey;
    return () => {
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current);
        flushTarget(leaving);
      }
      queued.current = new Map();
      sentBy.current = new Map();
      answeredFrom.current = new Map();
      setOverlay(NO_OVERLAY);
    };
  }, [scopeKey]);

  const setViewed = useStableCallback((path: string, viewed: boolean) => {
    setOverlay((current) => new Map(current).set(path, viewed));
    queued.current.set(path, viewed);
    if (flushTimer.current !== null) clearTimeout(flushTimer.current);
    const target = { environmentId, reference };
    flushTimer.current = setTimeout(() => flush(target), FLUSH_DELAY_MS);
  });

  return {
    enabled,
    isViewed: (path: string) => isFileViewed(path, states, overlay),
    isStale: (path: string) => !overlay.has(path) && isStaleViewedState(states?.get(path)),
    setViewed,
    truncated,
    error,
    refresh,
  };
}
