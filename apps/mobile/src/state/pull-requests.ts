import {
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "@t3tools/client-runtime/state/pull-requests";
import type { EnvironmentId, PullRequestDiffStat, PullRequestListInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import {
  pullRequestListHead,
  pullRequestStatKey,
  type PullRequestListPages,
} from "../features/pull-requests/pullRequestList";

export const pullRequestListPagesKey = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestListInput;
}) => JSON.stringify([target.environmentId, target.input]);

/** The pages loaded past each listing's head, keyed by {@link pullRequestListPagesKey}. */
export const pullRequestListPagesFamily = Atom.family((_key: string) =>
  Atom.make<PullRequestListPages | null>(null).pipe(Atom.setIdleTTL(5 * 60_000)),
);

/** Diff stats each environment has answered so far, so rows keep them when they scroll away. */
export const pullRequestListStatsFamily = Atom.family((_environmentId: string) =>
  Atom.make<ReadonlyMap<string, PullRequestDiffStat>>(new Map()).pipe(Atom.setIdleTTL(5 * 60_000)),
);

export const composerPullRequests = createPullRequestEnvironmentAtoms(connectionAtomRuntime, {
  // A new head can change which files GitHub still counts as viewed, so the viewed-files read is
  // refreshed where the new head lands. The detail atom still holds the previous answer here.
  detail: (target, value, registry) =>
    Effect.sync(() => {
      const previous = AsyncResult.value(registry.get(composerPullRequests.detail(target)));
      if (Option.isSome(previous) && previous.value.headSha !== value.headSha)
        registry.refresh(composerPullRequests.filesViewed(target));
    }),
  list: (target, value, registry) =>
    target.input.cursors === undefined
      ? Effect.sync(() =>
          registry.update(pullRequestListPagesFamily(pullRequestListPagesKey(target)), (previous) =>
            pullRequestListHead(previous, value),
          ),
        )
      : Effect.void,
  listStats: (target, value, registry) =>
    Effect.sync(() =>
      registry.update(pullRequestListStatsFamily(target.environmentId), (previous) => {
        const next = new Map(previous);
        for (const row of value.stats) next.set(pullRequestStatKey(row), row);
        return next;
      }),
    ),
});
export const pullRequestStackAtom = createPullRequestStackAtomFamily(
  connectionAtomRuntime,
  composerPullRequests.refreshes,
);
