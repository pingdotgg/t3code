import { useAtomValue } from "@effect/atom-react";
import {
  createLinkedPullRequestSummaryAtomFamily,
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "@t3tools/client-runtime/state/pull-requests";
import type {
  EnvironmentId,
  PullRequestListInput,
  PullRequestListStatsInput,
  PullRequestListEntry,
  PullRequestRef,
  PullRequestSummary,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useLayoutEffect, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  mergePullRequestLists,
  type EnvironmentPullRequestStat,
  type MergedPullRequestList,
} from "../components/pullRequest/pullRequestList.logic";
import { formatEnvironmentQueryError } from "./query";

export const pullRequestEnvironment = createPullRequestEnvironmentAtoms(connectionAtomRuntime);
export const linkedPullRequestDetailAtom = createLinkedPullRequestSummaryAtomFamily(
  connectionAtomRuntime,
  pullRequestEnvironment.refreshes,
);

export interface ObservedPullRequestSummary {
  readonly summary: PullRequestSummary;
  /** Client arrival time, the only ordering older servers leave us for same-dated snapshots. */
  readonly observedAt: number;
}

const observedPullRequestSummaryAtom = Atom.family((key: string) =>
  Atom.make<ObservedPullRequestSummary | null>(null).pipe(
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`web-pull-requests:observed-summary:${key}`),
  ),
);

/**
 * Positive when `incoming` is the newer snapshot. Merged is final. Then the host's own update
 * time, then the server's read-start time, which survives its caches; a snapshot without one
 * never beats a stamped read. Zero when neither side carries a read time.
 */
function compareSummaries(current: PullRequestSummary, incoming: PullRequestSummary): number {
  const merged = Number(incoming.state === "merged") - Number(current.state === "merged");
  if (merged !== 0) return merged;
  const updated = Date.parse(incoming.updatedAt) - Date.parse(current.updatedAt);
  if (updated !== 0) return updated;
  if (current.observedAt === undefined && incoming.observedAt === undefined) return 0;
  return (incoming.observedAt ?? -Infinity) - (current.observedAt ?? -Infinity);
}

export function newestPullRequestSummary(
  current: PullRequestSummary | null,
  observed: PullRequestSummary | null,
): PullRequestSummary | null {
  if (current === null) return observed;
  if (observed === null) return current;
  return compareSummaries(current, observed) >= 0 ? observed : current;
}

/** Reuse list status without treating its deferred line-count placeholders as real stats. */
export function pullRequestListEntryToSummary(entry: PullRequestListEntry): PullRequestSummary {
  return {
    provider: entry.provider,
    projectId: entry.projectId,
    repository: entry.repository,
    number: entry.number,
    title: entry.title,
    url: entry.url,
    state: entry.state,
    isDraft: entry.isDraft,
    headBranch: entry.headBranch,
    baseBranch: entry.baseBranch,
    updatedAt: entry.updatedAt,
    ...(entry.observedAt === undefined ? {} : { observedAt: entry.observedAt }),
    author: entry.author,
    ...(entry.reviewDecision === undefined ? {} : { reviewDecision: entry.reviewDecision }),
    ...(entry.checksState === undefined ? {} : { checksState: entry.checksState }),
    mergeability: entry.mergeability,
  };
}

// A project has one remote, so its id already pins the host. Leaving the host out lets a list
// row, a hostless legacy reference and a URL-derived thread reference share one entry.
function pullRequestSummaryKey(environmentId: EnvironmentId, reference: PullRequestRef): string {
  return JSON.stringify([
    environmentId,
    reference.projectId,
    reference.repository.toLowerCase(),
    reference.number,
  ]);
}

/** The observation to hold after `incoming` arrives. Returns `current` itself on a tie. */
export function newestPullRequestObservation(
  current: ObservedPullRequestSummary | null,
  incoming: ObservedPullRequestSummary | null,
): ObservedPullRequestSummary | null {
  if (current === null) return incoming;
  if (incoming === null) return current;
  let order = compareSummaries(current.summary, incoming.summary);
  // Client clocks only break ties between snapshots that both lack a server read time.
  if (
    order === 0 &&
    current.summary.observedAt === undefined &&
    incoming.summary.observedAt === undefined
  ) {
    order = incoming.observedAt - current.observedAt;
  }
  if (!(order > 0)) return current;
  // A sparse summary must not erase known status, or carry old detail stats into a new list read.
  return {
    ...incoming,
    summary: {
      ...incoming.summary,
      isDraft: incoming.summary.isDraft ?? current.summary.isDraft,
      mergeability: incoming.summary.mergeability ?? current.summary.mergeability,
      reviewDecision:
        incoming.summary.reviewDecision === undefined
          ? current.summary.reviewDecision
          : incoming.summary.reviewDecision,
      checksState:
        incoming.summary.checksState === undefined
          ? current.summary.checksState
          : incoming.summary.checksState,
    },
  };
}

function observePullRequestSummary(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
  summary: PullRequestSummary,
  observedAt: number,
): void {
  const atom = observedPullRequestSummaryAtom(pullRequestSummaryKey(environmentId, reference));
  appAtomRegistry.modify(atom, (previous) => {
    const next = newestPullRequestObservation(previous, { summary, observedAt });
    return next === previous ? [false, previous] : [true, next];
  });
}

export function useSharedPullRequestSummary(
  environmentId: EnvironmentId | null,
  reference: PullRequestRef | null,
  current: PullRequestSummary | null,
  observedAt: number | null = null,
): PullRequestSummary | null {
  const key =
    environmentId === null || reference === null
      ? "none"
      : pullRequestSummaryKey(environmentId, reference);
  const atom = observedPullRequestSummaryAtom(key);
  const observed = useAtomValue(atom);
  useLayoutEffect(() => {
    if (environmentId === null || reference === null || current === null || observedAt === null)
      return;
    observePullRequestSummary(environmentId, reference, current, observedAt);
  }, [current, environmentId, reference, observedAt]);
  return (
    newestPullRequestObservation(
      observed,
      current === null || observedAt === null ? null : { summary: current, observedAt },
    )?.summary ?? current
  );
}
export const pullRequestStackAtom = createPullRequestStackAtomFamily(
  connectionAtomRuntime,
  pullRequestEnvironment.refreshes,
);

export interface EnvironmentQueryTarget<Input> {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}

interface MergedEnvironmentQueryView<A> {
  /** One entry per query target that has answered, in the order the targets were given. */
  readonly values: ReadonlyArray<readonly [EnvironmentId, A]>;
  /** The first environment that failed. Others may still have answered — this is not fatal. */
  readonly error: string | null;
  readonly isPending: boolean;
  readonly observations: ReadonlyArray<readonly [EnvironmentId, A, number]>;
}

/**
 * The same per-environment query read across several environments at once. React cannot subscribe
 * to a list of atoms whose length changes, so the fan-out happens inside one derived atom keyed by
 * the targets — the same shape the cross-environment thread search uses.
 *
 * An environment that fails contributes nothing rather than blanking the page: the pull request
 * list is a union, and one unreachable machine should not hide the others' rows.
 */
function createMergedEnvironmentQuery<Input, A>(
  label: string,
  atomFor: (
    target: EnvironmentQueryTarget<Input>,
  ) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) {
  const family = Atom.family((key: string) =>
    Atom.make((get): MergedEnvironmentQueryView<A> => {
      const targets = JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>;
      const values: Array<readonly [EnvironmentId, A]> = [];
      const observations: Array<readonly [EnvironmentId, A, number]> = [];
      let error: string | null = null;
      let isPending = false;
      for (const target of targets) {
        const result = get(atomFor(target));
        isPending ||= result.waiting;
        if (result._tag === "Failure" && error === null) {
          error = formatEnvironmentQueryError(result.cause);
        }
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) values.push([target.environmentId, value]);
        if (result._tag === "Success") {
          observations.push([target.environmentId, result.value, result.timestamp]);
        }
      }
      return { values, error, isPending, observations };
    }).pipe(Atom.withLabel(`${label}:${key}`)),
  );
  const empty = Atom.make<MergedEnvironmentQueryView<A>>({
    values: [],
    observations: [],
    error: null,
    isPending: false,
  }).pipe(Atom.withLabel(`${label}:empty`));
  return function useMergedQuery(targets: ReadonlyArray<EnvironmentQueryTarget<Input>>) {
    const key = JSON.stringify(targets);
    const view = useAtomValue(targets.length === 0 ? empty : family(key));
    const refresh = useCallback(
      (override?: ReadonlyArray<EnvironmentQueryTarget<Input>>) => {
        const refreshTargets =
          override ?? (JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>);
        for (const atom of new Set(refreshTargets.map(atomFor))) {
          appAtomRegistry.refresh(atom);
        }
      },
      [key],
    );
    return { ...view, refresh };
  };
}

const usePullRequestListsQuery = createMergedEnvironmentQuery(
  "web-pull-requests:list",
  pullRequestEnvironment.list,
);

const usePullRequestStatsQuery = createMergedEnvironmentQuery(
  "web-pull-requests:list-stats",
  pullRequestEnvironment.listStats,
);

const usePullRequestTurnRefreshQuery = createMergedEnvironmentQuery(
  "web-pull-requests:turn-refreshes",
  ({ environmentId }: EnvironmentQueryTarget<Readonly<Record<string, never>>>) =>
    pullRequestEnvironment.refreshes({ environmentId, input: {} }),
);

export function usePullRequestTurnRefreshes(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<readonly [EnvironmentId, number]> {
  return usePullRequestTurnRefreshQuery(
    environmentIds.map((environmentId) => ({ environmentId, input: {} })),
  ).values;
}

export function usePullRequestTurnRefresh(environmentId: EnvironmentId): number | null {
  const result = useAtomValue(pullRequestEnvironment.refreshes({ environmentId, input: {} }));
  return Option.getOrNull(AsyncResult.value(result));
}

export interface MergedPullRequestListView {
  readonly data: MergedPullRequestList | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: (targets?: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>) => void;
}

/** One listing per environment, merged into the single list the page renders. */
export function usePullRequestList(
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>,
): MergedPullRequestListView {
  const query = usePullRequestListsQuery(targets);
  useLayoutEffect(() => {
    for (const [environmentId, answer, observedAt] of query.observations) {
      for (const entry of answer.entries) {
        observePullRequestSummary(
          environmentId,
          {
            projectId: entry.projectId,
            host: entry.host,
            repository: entry.repository,
            number: entry.number,
          },
          pullRequestListEntryToSummary(entry),
          observedAt,
        );
      }
    }
  }, [query.observations]);
  const data = useMemo(() => mergePullRequestLists(query.values), [query.values]);
  return { data, error: query.error, isPending: query.isPending, refresh: query.refresh };
}

/** The line counts for the rows on screen, asked of each environment for its own rows. */
export function usePullRequestListStats(
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListStatsInput>>,
): {
  readonly stats: ReadonlyArray<EnvironmentPullRequestStat> | null;
  readonly isPending: boolean;
  readonly refresh: (
    targets?: ReadonlyArray<EnvironmentQueryTarget<PullRequestListStatsInput>>,
  ) => void;
} {
  const query = usePullRequestStatsQuery(targets);
  const stats = useMemo(
    () =>
      query.values.length === 0
        ? null
        : query.values.flatMap(([environmentId, result]) =>
            result.stats.map((stat) => ({ ...stat, environmentId })),
          ),
    [query.values],
  );
  return { stats, isPending: query.isPending, refresh: query.refresh };
}
