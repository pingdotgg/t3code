import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestDiffStat, PullRequestListInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { use, useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import { composerPullRequests } from "../../state/pull-requests";
import {
  appendPullRequestListPage,
  mergeEnvironmentPullRequestPages,
  nextPullRequestListInput,
  pullRequestListHead,
  pullRequestListKey,
  scopedPullRequestListKey,
  type EnvironmentPullRequestListEntry,
  type PullRequestListPages,
} from "./pullRequestList";

const pagesFamily = Atom.family((_key: string) =>
  Atom.make<PullRequestListPages | null>(null).pipe(Atom.setIdleTTL(5 * 60_000)),
);
const statsFamily = Atom.family((_environmentId: string) =>
  Atom.make<ReadonlyMap<string, PullRequestDiffStat>>(new Map()).pipe(Atom.setIdleTTL(5 * 60_000)),
);
const statKey = (row: Pick<PullRequestDiffStat, "projectId" | "repository" | "number">) =>
  `${row.projectId}:${row.repository}:${row.number}`;

type ListTarget = { readonly environmentId: EnvironmentId; readonly input: PullRequestListInput };
const sourcesFamily = Atom.family((key: string) => {
  const targets: readonly ListTarget[] = JSON.parse(key);
  return Atom.make((get) =>
    targets.map((target) => {
      const result = get(composerPullRequests.list(target));
      const head = Option.getOrNull(AsyncResult.value(result));
      const cached = get(pagesFamily(JSON.stringify(target)));
      return {
        target,
        result,
        pages: head ? pullRequestListHead(cached, head) : cached,
        stats: get(statsFamily(target.environmentId)),
      };
    }),
  );
});

export function usePullRequestList(targets: readonly ListTarget[]) {
  const registry = use(RegistryContext);
  const scopeKey = JSON.stringify(targets);
  const activeScope = useRef(scopeKey);
  const sources = useAtomValue(sourcesFamily(scopeKey));
  const requests = useRef<{ page?: AbortController; refresh?: AbortController }>({});
  const [loading, setLoading] = useState({
    key: scopeKey,
    page: false,
    refresh: false,
    error: null as string | null,
  });
  const state = loading.key === scopeKey ? loading : { page: false, refresh: false, error: null };
  useLayoutEffect(() => {
    activeScope.current = scopeKey;
    return () => {
      requests.current.page?.abort();
      requests.current.refresh?.abort();
      requests.current = {};
    };
  }, [scopeKey, activeScope]);
  useEffect(() => {
    for (const { target, pages } of sources)
      if (pages) registry.set(pagesFamily(JSON.stringify(target)), pages);
  }, [registry, sources]);

  const loadMore = useCallback(
    async (retry = false) => {
      if (requests.current.page || requests.current.refresh || (!retry && state.error)) return;
      const continuations = targets.flatMap((target) => {
        const pagesAtom = pagesFamily(JSON.stringify(target));
        const pages = registry.get(pagesAtom);
        const input = pages && nextPullRequestListInput(pages, target.input);
        return pages && input ? [{ target, pagesAtom, pages, input }] : [];
      });
      if (!continuations.length) return;
      const controller = new AbortController();
      requests.current.page = controller;
      setLoading({ key: scopeKey, page: true, refresh: false, error: null });
      const responses = await Promise.allSettled(
        continuations.map(async ({ target, pagesAtom, pages, input }) => {
          const response = await executeAtomQuery(
            registry,
            composerPullRequests.list({ ...target, input }),
            {
              signal: controller.signal,
              refresh: retry,
              reportFailure: false,
            },
          );
          if (controller.signal.aborted || activeScope.current !== scopeKey) return;
          if (response._tag === "Failure") throw squashAtomCommandFailure(response);
          if (response.value.errors.length)
            throw new Error(response.value.errors.map((error) => error.message).join("\n"));
          const next = appendPullRequestListPage(
            registry.get(pagesAtom) ?? pages,
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
      if (requests.current.page === controller) delete requests.current.page;
      if (!controller.signal.aborted && activeScope.current === scopeKey)
        setLoading({ key: scopeKey, page: false, refresh: false, error: requestErrors(responses) });
    },
    [targets, registry, scopeKey, state.error, activeScope],
  );

  const onRefresh = async () => {
    if (!targets.length || requests.current.refresh) return;
    requests.current.page?.abort();
    delete requests.current.page;
    const controller = new AbortController();
    requests.current.refresh = controller;
    setLoading({ key: scopeKey, page: false, refresh: true, error: null });
    const responses = await Promise.allSettled(
      targets.map(async (target) => {
        await composerPullRequests.invalidate.run(registry, {
          environmentId: target.environmentId,
          input: {},
        });
        if (controller.signal.aborted) return;
        const response = await executeAtomQuery(registry, composerPullRequests.list(target), {
          refresh: true,
          signal: controller.signal,
          reportFailure: false,
        });
        if (controller.signal.aborted || activeScope.current !== scopeKey) return;
        if (response._tag === "Failure") throw squashAtomCommandFailure(response);
        registry.set(
          pagesFamily(JSON.stringify(target)),
          pullRequestListHead(null, response.value),
        );
      }),
    );
    if (requests.current.refresh === controller) delete requests.current.refresh;
    if (!controller.signal.aborted && activeScope.current === scopeKey)
      setLoading({ key: scopeKey, page: false, refresh: false, error: requestErrors(responses) });
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
  const statsKey = JSON.stringify(
    targets.flatMap(({ environmentId }) => {
      const refs = visibleRows
        .filter((row) => row.environmentId === environmentId && row.additions + row.deletions === 0)
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
  useEffect(() => {
    for (const { environmentId, result } of counts) {
      if (result._tag !== "Success" || result.waiting) continue;
      registry.update(statsFamily(environmentId), (previous) => {
        const next = new Map(previous);
        for (const row of result.value.stats) next.set(statKey(row), row);
        return next;
      });
    }
  }, [registry, counts]);

  const updateEntry = useCallback(
    (entry: EnvironmentPullRequestListEntry, patch: Partial<EnvironmentPullRequestListEntry>) => {
      const target = targets.find((target) => target.environmentId === entry.environmentId);
      if (!target) return;
      registry.update(pagesFamily(JSON.stringify(target)), (previous) =>
        previous
          ? {
              ...previous,
              entries: previous.entries.map((row) =>
                pullRequestListKey(row) === pullRequestListKey(entry)
                  ? { ...row, ...patch, observedAt: Date.now() }
                  : row,
              ),
            }
          : previous,
      );
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
  const listing = useMemo(() => ({ ...data, errors: [...data.errors, ...errors] }), [data, errors]);
  return {
    data: listing,
    entries: data.entries,
    error: errors.map((error) => error.message).join("\n") || null,
    isPending: sources.some(({ result }) => result.waiting) && !data.entries.length,
    continued: data.continued,
    loadMore,
    onRefresh,
    onViewableItemsChanged,
    updateEntry,
    refreshing: state.refresh,
    loadingMore: state.page,
    loadMoreError: state.error,
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
