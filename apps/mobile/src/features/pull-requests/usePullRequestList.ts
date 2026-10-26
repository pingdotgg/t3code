import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestListInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { use, useCallback, useMemo, useState } from "react";
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

  const loadMore = (retry = false) => {
    if (page.waiting || refresh.waiting || (!retry && loadError)) return;
    if (!continuations(registry, targets).length) return;
    registry.set(refreshAtom, Atom.Reset);
    registry.set(pageAtom, retry);
  };

  const onRefresh = () => {
    if (!targets.length || refresh.waiting) return;
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
                      const stat = stats.get(statKey(entry));
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
  // all an offline environment has.
  const entries = useMemo(
    () =>
      withShownPullRequestStats(
        data.entries,
        counts.flatMap(({ environmentId, result }) =>
          AsyncResult.isSuccess(result) ? [{ environmentId, stats: result.value.stats }] : [],
        ),
      ),
    [data.entries, counts],
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
