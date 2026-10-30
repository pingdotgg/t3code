import {
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "@t3tools/client-runtime/state/pull-requests";
import type { EnvironmentId, PullRequestListInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import {
  EMPTY_PULL_REQUEST_STATS_CACHE,
  patchPullRequestListEntry,
  pullRequestListHead,
  withAnsweredPullRequestStats,
  withListedPullRequests,
  type PullRequestListPages,
  type PullRequestStatsCache,
} from "../features/pull-requests/pullRequestList";

export const pullRequestListPagesKey = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestListInput;
}) => JSON.stringify([target.environmentId, target.input]);

const pullRequestListPagesEnvironments = new WeakMap<object, EnvironmentId>();
/** The pages loaded past each listing's head, keyed by {@link pullRequestListPagesKey}. */
export const pullRequestListPagesFamily = Atom.family((key: string) => {
  const atom = Atom.make<PullRequestListPages | null>(null).pipe(Atom.setIdleTTL(5 * 60_000));
  const [environmentId]: [EnvironmentId] = JSON.parse(key);
  pullRequestListPagesEnvironments.set(atom, environmentId);
  return atom;
});

/** Diff stats each environment has answered so far, so rows keep them when they scroll away. */
export const pullRequestListStatsFamily = Atom.family((_environmentId: string) =>
  Atom.make<PullRequestStatsCache>(EMPTY_PULL_REQUEST_STATS_CACHE).pipe(
    Atom.setIdleTTL(5 * 60_000),
  ),
);

export const composerPullRequests = createPullRequestEnvironmentAtoms(connectionAtomRuntime, {
  // Rows on pages past each listing's head; the head itself is patched where it is cached.
  actionReply: (target, reply, registry) =>
    Effect.sync(() => {
      const { state, isDraft, updatedAt, observedAt } = reply;
      const patch = { state, ...(isDraft === undefined ? {} : { isDraft }), updatedAt };
      for (const atom of registry.getNodes().keys()) {
        if (typeof atom === "string") continue;
        if (pullRequestListPagesEnvironments.get(atom) !== target.environmentId) continue;
        registry.update(atom as Atom.Writable<PullRequestListPages | null>, (pages) =>
          patchPullRequestListEntry(pages, null, target.input, patch, observedAt ?? Date.now()),
        );
      }
    }),
  // A new head can change which files GitHub still counts as viewed, so the viewed-files read is
  // refreshed where the new head lands. The detail atom still holds the previous answer here.
  detail: (target, value, registry) =>
    Effect.sync(() => {
      const previous = AsyncResult.value(registry.get(composerPullRequests.detail(target)));
      if (Option.isSome(previous) && previous.value.headSha !== value.headSha)
        registry.refresh(composerPullRequests.filesViewed(target));
    }),
  list: (target, value, registry) =>
    Effect.sync(() => {
      const statsAtom = pullRequestListStatsFamily(target.environmentId);
      const { cache, refresh } = withListedPullRequests(registry.get(statsAtom), value.entries);
      registry.set(statsAtom, cache);
      for (const input of refresh)
        registry.refresh(
          composerPullRequests.listStats({ environmentId: target.environmentId, input }),
        );
      if (target.input.cursors === undefined)
        registry.update(pullRequestListPagesFamily(pullRequestListPagesKey(target)), (previous) =>
          pullRequestListHead(previous, value),
        );
    }),
  listStats: (target, value, registry) =>
    Effect.sync(() =>
      registry.update(pullRequestListStatsFamily(target.environmentId), (previous) =>
        withAnsweredPullRequestStats(previous, target.input, value.stats),
      ),
    ),
});
export const pullRequestStackAtom = createPullRequestStackAtomFamily(
  connectionAtomRuntime,
  composerPullRequests.refreshes,
);
