import { RegistryContext, useAtomMount, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestDiffStat, PullRequestListInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { use, useCallback, useMemo, useState } from "react";
import { environmentCatalog } from "../../connection/catalog";
import {
  composerPullRequests,
  pullRequestListPagesFamily,
  pullRequestListPagesKey,
  pullRequestListStatsFamily,
} from "../../state/pull-requests";
import {
  appendPullRequestListPage,
  mergeEnvironmentPullRequestPages,
  nextPullRequestListInput,
  patchPullRequestListEntry,
  pullRequestListHead,
  shownPullRequestListPages,
  pullRequestStatKey as statKey,
  scopedPullRequestListKey,
  withShownPullRequestStats,
  type EnvironmentPullRequestListEntry,
  type PullRequestListPages,
} from "./pullRequestList";

type ListTarget = { readonly environmentId: EnvironmentId; readonly input: PullRequestListInput };
type Read = <A>(atom: Atom.Atom<A>) => A;

/** The head the list query holds now, cached or answered. */
function currentHead(read: Read, target: ListTarget) {
  return Option.getOrNull(AsyncResult.value(read(composerPullRequests.list(target))));
}

function currentPages(read: Read, target: ListTarget): PullRequestListPages | null {
  return shownPullRequestListPages(
    read(pullRequestListPagesFamily(pullRequestListPagesKey(target))),
    currentHead(read, target),
  );
}

const sourcesFamily = Atom.family((key: string) => {
  const targets: readonly ListTarget[] = JSON.parse(key);
  return Atom.make((get) =>
    targets.map((target) => ({
      target,
      result: get(composerPullRequests.list(target)),
      pages: currentPages(get, target),
      stats: get(pullRequestListStatsFamily(target.environmentId)),
    })),
  );
});

function continuations(registry: AtomRegistry.AtomRegistry, targets: readonly ListTarget[]) {
  return targets.flatMap((target) => {
    const pages = currentPages((atom) => registry.get(atom), target);
    const input = pages && nextPullRequestListInput(pages, target.input);
    return pages && input ? [{ target, pages, input }] : [];
  });
}

async function loadNextPages(
  registry: AtomRegistry.AtomRegistry,
  targets: readonly ListTarget[],
  retry: boolean,
  signal: AbortSignal,
) {
  const responses = await Promise.allSettled(
    continuations(registry, targets).map(async ({ target, pages, input }) => {
      const response = await executeAtomQuery(
        registry,
        composerPullRequests.list({ ...target, input }),
        {
          signal,
          refresh: retry,
          reportFailure: false,
        },
      );
      if (signal.aborted) return;
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      if (response.value.errors.length)
        throw new Error(response.value.errors.map((error) => error.message).join("\n"));
      const pagesAtom = pullRequestListPagesFamily(pullRequestListPagesKey(target));
      const next = appendPullRequestListPage(
        currentPages((atom) => registry.get(atom), target) ?? pages,
        response.value,
        input,
      );
      registry.set(pagesAtom, next);
      if (
        input.cursors &&
        Object.keys(next.nextCursors).length &&
        JSON.stringify(Object.entries(input.cursors).sort()) ===
          JSON.stringify(Object.entries(next.nextCursors).sort())
      )
        throw new Error("Couldn't advance the list. Try again.");
    }),
  );
  return requestErrors(responses);
}

async function refreshHeads(
  registry: AtomRegistry.AtomRegistry,
  targets: readonly ListTarget[],
  signal: AbortSignal,
) {
  const responses = await Promise.allSettled(
    targets.map(async (target) => {
      await composerPullRequests.invalidate.run(registry, {
        environmentId: target.environmentId,
        input: {},
      });
      if (signal.aborted) return;
      const response = await executeAtomQuery(registry, composerPullRequests.list(target), {
        refresh: true,
        signal,
        reportFailure: false,
      });
      if (signal.aborted) return;
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      registry.set(
        pullRequestListPagesFamily(pullRequestListPagesKey(target)),
        pullRequestListHead(null, response.value),
      );
    }),
  );
  return requestErrors(responses);
}

// One load of each kind per list scope. The atoms are not kept alive, so leaving a scope (a
// filter change, unmount) interrupts its load and aborts the requests.
const pageLoadFamily = Atom.family((scopeKey: string) =>
  Atom.fn((retry: boolean, get) =>
    Effect.promise((signal) => loadNextPages(get.registry, JSON.parse(scopeKey), retry, signal)),
  ),
);
const refreshLoadFamily = Atom.family((scopeKey: string) =>
  Atom.fn((_: void, get) =>
    Effect.promise((signal) => refreshHeads(get.registry, JSON.parse(scopeKey), signal)),
  ),
);

// Changes when any of the scope's environments brings up a new session.
const sessionsFamily = Atom.family((scopeKey: string) =>
  Atom.make((get) =>
    (JSON.parse(scopeKey) as readonly ListTarget[])
      .map(({ environmentId }) => get(environmentCatalog.sessionGenerationAtom(environmentId)))
      .join(),
  ),
);

const settledError = (result: AsyncResult.AsyncResult<string | null, never>) =>
  AsyncResult.isSuccess(result) && !result.waiting ? result.value : null;

export function usePullRequestList(targets: readonly ListTarget[]) {
  const registry = use(RegistryContext);
  const scopeKey = JSON.stringify(targets);
  const sources = useAtomValue(sourcesFamily(scopeKey));
  const pageAtom = pageLoadFamily(scopeKey);
  const refreshAtom = refreshLoadFamily(scopeKey);
  const page = useAtomValue(pageAtom);
  const refresh = useAtomValue(refreshAtom);
  // Starting one kind of load clears the other, so at most one holds an error.
  const loadError = settledError(refresh) ?? settledError(page);

  // A page or refresh asked for while an environment was unreachable fails at once, and its
  // error stops loading on scroll. Once it is back, ask for the page again; a refresh's error is
  // stale by then because the list queries re-run on reconnect.
  // A listener alone does not compute the atom, so nothing would follow the connections.
  useAtomMount(sessionsFamily(scopeKey));
  useAtomSubscribe(sessionsFamily(scopeKey), () => {
    const pageResult = registry.get(pageAtom);
    const refreshResult = registry.get(refreshAtom);
    if (settledError(refreshResult) !== null) registry.set(refreshAtom, Atom.Reset);
    else if (settledError(pageResult) !== null && !refreshResult.waiting)
      registry.set(pageAtom, true);
  });

  // Read from the registry, not the render: a second onEndReached before React re-renders must
  // see the load the first one started.
  const loadMore = (retry = false) => {
    const pageResult = registry.get(pageAtom);
    const refreshResult = registry.get(refreshAtom);
    if (pageResult.waiting || refreshResult.waiting) return;
    if (!retry && (settledError(refreshResult) ?? settledError(pageResult))) return;
    if (!continuations(registry, targets).length) return;
    registry.set(refreshAtom, Atom.Reset);
    registry.set(pageAtom, retry);
  };

  const onRefresh = () => {
    if (!targets.length || registry.get(refreshAtom).waiting) return;
    registry.set(pageAtom, Atom.Reset);
    registry.set(refreshAtom, undefined);
  };

  const data = useMemo(
    () =>
      mergeEnvironmentPullRequestPages(
        sources.flatMap(({ target, pages, stats }) =>
          pages
            ? [
                {
                  environmentId: target.environmentId,
                  pages: {
                    ...pages,
                    entries: pages.entries.map((entry) => {
                      const stat = stats.stats.get(statKey(entry));
                      return stat
                        ? { ...entry, additions: stat.additions, deletions: stat.deletions }
                        : entry;
                    }),
                  },
                },
              ]
            : [],
        ),
      ),
    [sources],
  );
  const [visible, setVisible] = useState<{
    key: string;
    rows: readonly EnvironmentPullRequestListEntry[];
  }>({ key: scopeKey, rows: [] });
  const onViewableItemsChanged = useCallback(
    ({
      viewableItems,
    }: {
      viewableItems: readonly { item: EnvironmentPullRequestListEntry; isViewable: boolean }[];
    }) => {
      const rows = viewableItems.filter((token) => token.isViewable).map((token) => token.item);
      setVisible((previous) =>
        previous.key === scopeKey &&
        previous.rows.map(scopedPullRequestListKey).join() ===
          rows.map(scopedPullRequestListKey).join()
          ? previous
          : { key: scopeKey, rows },
      );
    },
    [scopeKey],
  );
  const visibleRows =
    visible.key === scopeKey && visible.rows.length ? visible.rows : data.entries.slice(0, 8);
  // Visible rows carry the cached-answer overlay below. Decide which still need stats on the rows
  // without it, so a cached answer shown offline does not unmount the query that holds it.
  const withoutCachedOverlay = new Map(
    data.entries.map((row) => [scopedPullRequestListKey(row), row]),
  );
  const statsKey = JSON.stringify(
    targets.flatMap(({ environmentId }) => {
      const refs = visibleRows
        .filter((row) => {
          const base = withoutCachedOverlay.get(scopedPullRequestListKey(row)) ?? row;
          return row.environmentId === environmentId && base.additions + base.deletions === 0;
        })
        .map(({ projectId, host, repository, number }) => ({
          projectId,
          host,
          repository,
          number,
        }));
      return refs.length ? [{ environmentId, input: { refs } }] : [];
    }),
  );
  const statsAtom = useMemo(() => {
    const queries: readonly Parameters<typeof composerPullRequests.listStats>[0][] =
      JSON.parse(statsKey);
    return Atom.make((get) =>
      queries.map((target) => ({
        environmentId: target.environmentId,
        result: get(composerPullRequests.listStats(target)),
      })),
    );
  }, [statsKey]);
  const counts = useAtomValue(statsAtom);
  // Server answers land in pullRequestListStatsFamily; these cover a cached answer, which is
  // all an offline environment has. Scrolling makes a new stats query, which has no answer until
  // its cached rows load, so each environment keeps the answer it showed until the new one lands.
  const [shown, setShown] = useState({ counts, answers: answeredStats(counts, []) });
  if (shown.counts !== counts) setShown({ counts, answers: answeredStats(counts, shown.answers) });
  const entries = useMemo(
    () => withShownPullRequestStats(data.entries, shown.answers),
    [data.entries, shown.answers],
  );

  const updateEntry = useCallback(
    (entry: EnvironmentPullRequestListEntry, patch: Partial<EnvironmentPullRequestListEntry>) => {
      const target = targets.find((target) => target.environmentId === entry.environmentId);
      if (!target) return;
      const pagesAtom = pullRequestListPagesFamily(pullRequestListPagesKey(target));
      const read = <A>(atom: Atom.Atom<A>) => registry.get(atom);
      const patched = patchPullRequestListEntry(
        read(pagesAtom),
        currentHead(read, target),
        entry,
        patch,
        Date.now(),
      );
      if (patched) registry.set(pagesAtom, patched);
      registry.refresh(composerPullRequests.list(target));
    },
    [registry, targets],
  );
  const errors = useMemo(
    () =>
      sources.flatMap(({ target, result }) => {
        if (result._tag !== "Failure") return [];
        const cause = Cause.squash(result.cause);
        return [
          {
            environmentId: target.environmentId,
            projectTitle: "",
            message: cause instanceof Error ? cause.message : "Couldn't load pull requests.",
          },
        ];
      }),
    [sources],
  );
  const listing = useMemo(
    () => ({ ...data, entries, errors: [...data.errors, ...errors] }),
    [data, entries, errors],
  );
  return {
    data: listing,
    entries,
    error: errors.map((error) => error.message).join("\n") || null,
    isPending: sources.some(({ result }) => result.waiting) && !data.entries.length,
    continued: data.continued,
    loadMore,
    onRefresh,
    onViewableItemsChanged,
    updateEntry,
    refreshing: refresh.waiting,
    loadingMore: page.waiting,
    loadMoreError: loadError,
    hasMore: sources.some(
      ({ pages, target }) => pages && nextPullRequestListInput(pages, target.input),
    ),
  };
}

function requestErrors(results: readonly PromiseSettledResult<unknown>[]) {
  return (
    results
      .flatMap((result) =>
        result.status === "rejected"
          ? [
              result.reason instanceof Error
                ? result.reason.message
                : "Couldn't load pull requests.",
            ]
          : [],
      )
      .join("\n") || null
  );
}

type StatsAnswer = {
  readonly environmentId: EnvironmentId;
  readonly stats: readonly PullRequestDiffStat[];
};

/** Each environment's newest stats answer, or the one it had while its query has none. */
function answeredStats(
  counts: readonly {
    readonly environmentId: EnvironmentId;
    readonly result: AsyncResult.AsyncResult<
      { readonly stats: readonly PullRequestDiffStat[] },
      unknown
    >;
  }[],
  previous: readonly StatsAnswer[],
): readonly StatsAnswer[] {
  const next = counts.flatMap(({ environmentId, result }) => {
    const kept = previous.find((answer) => answer.environmentId === environmentId);
    if (!AsyncResult.isSuccess(result)) return kept ? [kept] : [];
    return kept?.stats === result.value.stats
      ? [kept]
      : [{ environmentId, stats: result.value.stats }];
  });
  return next.length === previous.length &&
    next.every((answer, index) => answer === previous[index])
    ? previous
    : next;
}
