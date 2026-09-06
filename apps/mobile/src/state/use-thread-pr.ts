import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  createLinkedPullRequestSummaryAtomFamily,
  pullRequestDetailToVcsStatus,
} from "@t3tools/client-runtime/state/pull-requests";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";
import { presentThreadPr, type ThreadPrPresentation } from "./thread-pr-presentation";

const pullRequestSummaryAtom = createLinkedPullRequestSummaryAtomFamily(connectionAtomRuntime);
const MAX_THREAD_PR_SNAPSHOTS = 500;

interface ThreadPrSnapshot {
  readonly identity: string;
  readonly presentation: ThreadPrPresentation;
}

// One bounded cache survives row virtualization without retaining one live
// atom for every thread or pull request ever seen.
const threadPrSnapshotsAtom = Atom.make<ReadonlyMap<string, ThreadPrSnapshot>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-pr-snapshots"),
);

export {
  presentThreadPr,
  type ThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

/**
 * Live status for a thread's server-provided PR. Visible rows share a summary
 * request for the same PR in the same environment.
 */
export function useThreadPr(thread: EnvironmentThreadShell): ThreadPrPresentation | null {
  const pullRequestRef = thread.linkedPullRequest ?? thread.branchPullRequest ?? null;
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const snapshotIdentity = JSON.stringify(pullRequestRef);
  // Select this row's entry so writes for other rows do not re-render it.
  const snapshotEntry = useAtomValue(
    threadPrSnapshotsAtom,
    useCallback(
      (current: ReadonlyMap<string, ThreadPrSnapshot>) => current.get(threadKey),
      [threadKey],
    ),
  );
  const snapshot = snapshotEntry?.identity === snapshotIdentity ? snapshotEntry.presentation : null;
  const pullRequestSummary = useEnvironmentQuery(
    pullRequestRef === null
      ? null
      : pullRequestSummaryAtom({
          environmentId: thread.environmentId,
          input: {
            projectId: pullRequestRef.projectId,
            repository: pullRequestRef.repository,
            number: pullRequestRef.number,
          },
        }),
  );

  const live = useMemo<ThreadPrPresentation | null | undefined>(() => {
    if (pullRequestRef === null) return null;
    const summary = pullRequestSummary.data;
    return summary === null
      ? undefined
      : presentThreadPr(pullRequestDetailToVcsStatus(summary), {
          kind: summary.provider,
          name: summary.provider,
          baseUrl: "",
        });
  }, [pullRequestRef, pullRequestSummary.data]);

  useEffect(() => {
    if (live === undefined) return;
    appAtomRegistry.modify(threadPrSnapshotsAtom, (current) => {
      const existing = current.get(threadKey);
      if (live === null) {
        if (existing === undefined) return [false, current];
        const next = new Map(current);
        next.delete(threadKey);
        return [true, next];
      }
      if (existing?.identity === snapshotIdentity && existing.presentation === live) {
        return [false, current];
      }
      const next = new Map(current);
      next.delete(threadKey);
      next.set(threadKey, { identity: snapshotIdentity, presentation: live });
      while (next.size > MAX_THREAD_PR_SNAPSHOTS) {
        const oldestKey = next.keys().next().value;
        if (oldestKey === undefined) break;
        next.delete(oldestKey);
      }
      return [true, next];
    });
  }, [live, snapshotIdentity, threadKey]);

  return live === undefined ? snapshot : live;
}
