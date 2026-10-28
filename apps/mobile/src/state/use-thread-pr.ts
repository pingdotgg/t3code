import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  createLinkedPullRequestSummaryAtomFamily,
  pullRequestDetailToVcsStatus,
} from "@t3tools/client-runtime/state/pull-requests";
import type { EnvironmentId, PullRequestSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";
import { useEnvironmentQuery } from "./query";
import {
  rememberBounded,
  resolveThreadPrSource,
  presentThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

const MAX_PULL_REQUEST_SNAPSHOTS = 500;

// One bounded cache survives row virtualization (the summary query is dropped once idle) without
// retaining one live atom for every pull request ever seen.
const pullRequestSnapshotsAtom = Atom.make<ReadonlyMap<string, PullRequestSummary>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-pr-snapshots"),
);

function snapshotKey(
  environmentId: EnvironmentId,
  reference: { readonly projectId: string; readonly repository: string; readonly number: number },
): string {
  return JSON.stringify([
    environmentId,
    reference.projectId,
    reference.repository,
    reference.number,
  ]);
}

const pullRequestSummaryAtom = createLinkedPullRequestSummaryAtomFamily(
  connectionAtomRuntime,
  undefined,
  ({ environmentId, input }, summary, registry) =>
    Effect.sync(() =>
      registry.update(pullRequestSnapshotsAtom, (current) =>
        rememberBounded(
          current,
          snapshotKey(environmentId, input),
          summary,
          MAX_PULL_REQUEST_SNAPSHOTS,
        ),
      ),
    ),
);

export { type ThreadPr, type ThreadPrPresentation } from "./thread-pr-presentation";

export function useThreadPr(thread: EnvironmentThreadShell): ThreadPrPresentation | null {
  const supportsLinks = useAtomValue(
    serverEnvironment.configValueAtom(thread.environmentId),
    (config) => config !== null,
  );
  const { linkedPresentation, pullRequestRef } = useMemo(
    () =>
      resolveThreadPrSource(
        {
          pullRequests: thread.pullRequests,
          linkedPullRequest: thread.linkedPullRequest,
          branchPullRequest: thread.branchPullRequest,
        },
        supportsLinks,
      ),
    [thread.pullRequests, thread.linkedPullRequest, thread.branchPullRequest, supportsLinks],
  );
  const key = pullRequestRef === null ? null : snapshotKey(thread.environmentId, pullRequestRef);
  // Select this row's entry so answers for other pull requests do not re-render it.
  const snapshot = useAtomValue(pullRequestSnapshotsAtom, (current) =>
    key === null ? undefined : current.get(key),
  );
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
  const summary = pullRequestRef === null ? undefined : (pullRequestSummary.data ?? snapshot);
  // Rows pass `pr` into callbacks; a fresh object per render would invalidate them.
  const summaryPresentation =
    summary === undefined
      ? null
      : presentThreadPr(pullRequestDetailToVcsStatus(summary), {
          kind: summary.provider,
          name: summary.provider,
          baseUrl: "",
        });
  return linkedPresentation ?? summaryPresentation;
}
