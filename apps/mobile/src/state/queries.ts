import {
  composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
  withLinkedComposerPullRequestsFirst,
} from "@t3tools/shared/composerPullRequestMatches";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { environmentSession } from "./session";
import { useEnvironmentPresentation } from "./presentation";
import type { VcsRefTarget } from "@t3tools/client-runtime/state/vcs";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ProjectId,
  ThreadPullRequestLink,
  VcsListRefsResult,
  VcsRef,
} from "@t3tools/contracts";
import {
  createThreadSearchResultsAtomFamily,
  makeThreadSearchKey,
  visibleThreadSearch,
  type EnvironmentThreadSearchMatch,
  type SettledThreadSearch,
  type ThreadSearchResultsState,
  type ThreadSearchScope,
} from "@t3tools/client-runtime/state/thread-search";
import { THREAD_SEARCH_QUERY_MAX_LENGTH } from "@t3tools/contracts";
import { messageSearchTokens } from "@t3tools/shared/paletteSearch";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";

import { appAtomRegistry } from "./atom-registry";
import { orchestrationEnvironment } from "./orchestration";
import { olderSettledThreads, threadFamilies } from "./threads";
import { projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";
import { vcsEnvironment } from "./vcs";
import { composerPullRequests } from "./pull-requests";
import {
  buildCheckpointDiffTargets,
  normalizeComposerPathSearchQuery,
  type CheckpointDiffTarget,
} from "./queryTargets";

const COMPOSER_PATH_SEARCH_DEBOUNCE_MS = 200;
const COMPOSER_PATH_SEARCH_LIMIT = 20;
const THREAD_SEARCH_DEBOUNCE_MS = 120;
const VCS_REF_LIST_LIMIT = 100;
const EMPTY_REFS: ReadonlyArray<VcsRef> = [];
const INITIAL_BRANCH_CURSORS = [undefined] as const;
const EMPTY_THREAD_SEARCH_MATCHES: ReadonlyArray<EnvironmentThreadSearchMatch> = Object.freeze([]);
const EMPTY_THREAD_SEARCH_ATOM = Atom.make<ThreadSearchResultsState>({
  matches: EMPTY_THREAD_SEARCH_MATCHES,
  isLoading: false,
  rows: [],
}).pipe(Atom.withLabel("mobile:thread-search:empty"));

const olderSettledBeforeAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(olderSettledThreads.olderSettledAtom(environmentId))?.before ?? null).pipe(
    Atom.withLabel(`mobile:older-settled-before:${environmentId}`),
  ),
);
// Whether any of these environments leaves older settled threads out, so short queries matter.
const anyOlderSettledAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) =>
    (JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>).some(
      (environmentId) => get(olderSettledBeforeAtom(environmentId)) !== null,
    ),
  ).pipe(Atom.withLabel(`mobile:any-older-settled:${environmentIdsKey}`)),
);
const threadSearch = createThreadSearchResultsAtomFamily({
  getSearchAtom: (environmentId, input) =>
    input.olderSettledBefore === undefined
      ? orchestrationEnvironment.threadSearch({ environmentId, input })
      : olderSettledThreads.searchAtom(environmentId, input),
  olderSettledBefore: olderSettledBeforeAtom,
  labelPrefix: "mobile:thread-search",
});

export interface ComposerPathSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string | null;
}

export function useDebouncedValue<A>(value: A, delayMs: number): A {
  const [debounced, setDebounced] = useState(value);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that publishes the value after the delay and clears on change
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [delayMs, value]);

  return debounced;
}

export function useComposerPullRequestSearch(input: {
  environmentId: EnvironmentId | null;
  projectId: ProjectId | null;
  repository: string | null;
  threadPullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  query: string | null;
}) {
  const query = useDebouncedValue(input.query, 180);
  const linked =
    input.projectId === null
      ? []
      : composerPullRequestsFromLinks(input.threadPullRequests ?? [], input.projectId);
  const ready =
    query === input.query &&
    query !== null &&
    input.environmentId !== null &&
    input.projectId !== null &&
    input.repository !== null;
  const numeric = query !== null && /^\d*$/.test(query);
  const list = useEnvironmentQuery(
    ready
      ? composerPullRequests.list({
          environmentId: input.environmentId!,
          input: {
            projectId: input.projectId!,
            state: "all",
            limit: 200,
            ...(!numeric && query ? { query } : {}),
          },
        })
      : null,
  );
  const number = numeric && query ? Number(query) : null;
  const hasExact = list.data?.entries.some(
    (entry) =>
      entry.number === number && entry.repository.toLowerCase() === input.repository?.toLowerCase(),
  );
  const exact = useEnvironmentQuery(
    ready && number !== null && Number.isSafeInteger(number) && number > 0 && !hasExact
      ? composerPullRequests.detail({
          environmentId: input.environmentId!,
          input: { projectId: input.projectId!, repository: input.repository!, number },
        })
      : null,
  );
  const entries = (() => {
    if (input.query === null || input.projectId === null || input.repository === null) return [];
    if (/^\d*$/.test(input.query)) {
      return filterComposerPullRequestMatches({
        entries: ready ? [...(exact.data ? [exact.data] : []), ...(list.data?.entries ?? [])] : [],
        linked,
        projectId: input.projectId,
        repository: input.repository,
        query: input.query,
        limit: 20,
      });
    }
    if (!ready) {
      return withLinkedComposerPullRequestsFirst({
        matches: [],
        linked,
        query: input.query,
        limit: 20,
      });
    }
    const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const found = [...(exact.data ? [exact.data] : []), ...(list.data?.entries ?? [])].filter(
      (entry) =>
        entry.projectId === input.projectId &&
        entry.repository.toLowerCase() === input.repository?.toLowerCase() &&
        words.every((word) =>
          `${entry.title} ${entry.headBranch} ${entry.baseBranch}`.toLowerCase().includes(word),
        ),
    );
    const unique = new Map<number, (typeof found)[number]>();
    for (const entry of found) if (!unique.has(entry.number)) unique.set(entry.number, entry);
    return withLinkedComposerPullRequestsFirst({
      matches: [...unique.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
      linked,
      query: query ?? "",
      limit: 20,
    });
  })();
  return {
    entries,
    isPending: input.query !== null && (query !== input.query || list.isPending || exact.isPending),
    error: list.error ?? list.data?.errors[0]?.message ?? exact.error,
  };
}

/**
 * Server matches for a thread search: message hits, and on environments that leave older settled
 * threads out of the shell, the rows of the best older matches, mounted into the thread list while
 * they show so the caller's own ranking finds them.
 */
export function useThreadSearch(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
  scope: ThreadSearchScope = {},
): {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  /** The query `matches` are for, which lags the typed one while a search runs. */
  readonly query: string;
  readonly isPending: boolean;
} {
  // A pasted wall of text searches by its start rather than failing the request.
  const normalizedQuery = query.trim().slice(0, THREAD_SEARCH_QUERY_MAX_LENGTH).trim();
  const debouncedQuery = useDebouncedValue(normalizedQuery, THREAD_SEARCH_DEBOUNCE_MS);
  const anyOlderSettled = useAtomValue(anyOlderSettledAtom(JSON.stringify(environmentIds)));
  // Messages need a word of three or more letters; older settled titles match from two.
  const canSearch =
    environmentIds.length > 0 &&
    ((scope.titlesOnly !== true && messageSearchTokens(normalizedQuery).long.length > 0) ||
      (anyOlderSettled && normalizedQuery.length >= 2));
  const settledQuery = canSearch && normalizedQuery === debouncedQuery ? debouncedQuery : null;
  const searchKeyOf = (searchQuery: string) =>
    makeThreadSearchKey(environmentIds, searchQuery, scope);
  const searchKey = settledQuery === null ? null : searchKeyOf(settledQuery);
  const result = useAtomValue(
    searchKey === null ? EMPTY_THREAD_SEARCH_ATOM : threadSearch.results(searchKey),
  );
  const isPending = canSearch && (normalizedQuery !== debouncedQuery || result.isLoading);
  // What fast environments returned shows without waiting for a slow one;
  // callers keep shown rows in place with `nextShownOrder`.
  const ready =
    settledQuery !== null &&
    (!result.isLoading || result.matches.length > 0 || result.rows.length > 0)
      ? { query: settledQuery, matches: result.matches }
      : null;
  // Kept from earlier renders: React's pattern for information from previous renders.
  const [previous, setPrevious] = useState<SettledThreadSearch | null>(null);
  if (ready !== null && previous?.matches !== ready.matches) setPrevious(ready);
  const visible = canSearch
    ? visibleThreadSearch(normalizedQuery, ready, previous)
    : { query: "", matches: EMPTY_THREAD_SEARCH_MATCHES };
  // The shown results' rows stay mounted until newer results replace them.
  const shownKey = visible.query === "" ? null : searchKeyOf(visible.query);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the shown search results' rows into the shared thread registry until newer results replace them
  useEffect(() => {
    if (shownKey === null) return;
    const environments = (JSON.parse(shownKey) as [ReadonlyArray<EnvironmentId>])[0];
    const releases = environments.map((environmentId) =>
      threadFamilies.mountRows(
        appAtomRegistry,
        environmentId,
        `search:${shownKey}`,
        threadSearch.rows(shownKey, environmentId),
      ),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [shownKey]);
  return {
    matches: visible.matches,
    query: visible.query,
    isPending,
  };
}

export function useBranches(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query?: string | null;
}) {
  const query = input.query?.trim() ?? "";
  return useEnvironmentQuery(
    input.environmentId !== null && input.cwd !== null
      ? vcsEnvironment.listRefs({
          environmentId: input.environmentId,
          input: {
            cwd: input.cwd,
            ...(query.length > 0 ? { query } : {}),
            limit: VCS_REF_LIST_LIMIT,
          },
        })
      : null,
  );
}

export function usePaginatedBranches(target: VcsRefTarget) {
  const query = target.query?.trim() ?? "";
  const targetKey =
    target.environmentId !== null && target.cwd !== null
      ? JSON.stringify([target.environmentId, target.cwd, query])
      : null;
  const [pagination, setPagination] = useState<{
    readonly targetKey: string | null;
    readonly cursors: ReadonlyArray<number | undefined>;
  }>({
    targetKey,
    cursors: INITIAL_BRANCH_CURSORS,
  });
  const cursors = pagination.targetKey === targetKey ? pagination.cursors : INITIAL_BRANCH_CURSORS;
  const pageAtoms = useMemo(
    () =>
      target.environmentId !== null && target.cwd !== null
        ? cursors.map((cursor) =>
            vcsEnvironment.listRefs({
              environmentId: target.environmentId!,
              input: {
                cwd: target.cwd!,
                ...(query.length > 0 ? { query } : {}),
                ...(cursor === undefined ? {} : { cursor }),
                limit: VCS_REF_LIST_LIMIT,
              },
            }),
          )
        : [],
    [target.environmentId, target.cwd, query, cursors],
  );
  const pagesAtom = useMemo(
    () =>
      Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
        Atom.withLabel(`mobile:vcs-ref-pages:${targetKey ?? "empty"}`),
      ),
    [pageAtoms, targetKey],
  );
  const results = useAtomValue(pagesAtom);
  const values = results.flatMap((result) => {
    const value = AsyncResult.getOrElse(result, () => null);
    return value === null ? [] : [value];
  });
  const refs = new Map<string, VcsRef>();
  for (const value of values) {
    for (const ref of value.refs) {
      refs.set(ref.name, ref);
    }
  }
  const first = values[0] ?? null;
  const last = values.at(-1) ?? null;
  const data: VcsListRefsResult | null =
    first === null || last === null
      ? null
      : {
          refs: [...refs.values()],
          isRepo: first.isRepo,
          hasPrimaryRemote: first.hasPrimaryRemote,
          nextCursor: last.nextCursor,
          totalCount: Math.max(...values.map((value) => value.totalCount)),
        };
  const lastResult = results.at(-1);
  const isFetchingNextPage =
    results.length > 1 &&
    lastResult?.waiting === true &&
    Option.isNone(AsyncResult.value(lastResult));
  const failed = results.find((result) => result._tag === "Failure");
  const error =
    failed?._tag === "Failure"
      ? (() => {
          const cause = Cause.squash(failed.cause);
          return cause instanceof Error && cause.message.trim().length > 0
            ? cause.message
            : "Failed to load refs.";
        })()
      : null;
  const refresh = () => {
    const firstPage = pageAtoms[0];
    setPagination({ targetKey, cursors: INITIAL_BRANCH_CURSORS });
    if (firstPage !== undefined) {
      appAtomRegistry.refresh(firstPage);
    }
  };
  const loadNext = () => {
    if (targetKey === null || data?.nextCursor === null || data?.nextCursor === undefined) {
      return;
    }
    setPagination((current) => {
      const currentCursors =
        current.targetKey === targetKey ? current.cursors : INITIAL_BRANCH_CURSORS;
      return currentCursors.includes(data.nextCursor!)
        ? { targetKey, cursors: currentCursors }
        : { targetKey, cursors: [...currentCursors, data.nextCursor!] };
    });
  };

  return {
    data,
    refs: data?.refs ?? EMPTY_REFS,
    error,
    isPending: results.some((result) => result.waiting),
    isFetchingNextPage,
    refresh,
    loadNext,
  };
}

export function useComposerPathSearch(target: ComposerPathSearchTarget) {
  const query = normalizeComposerPathSearchQuery(target.query);
  const normalizedTarget = { environmentId: target.environmentId, cwd: target.cwd, query };
  const debouncedTarget = useDebouncedValue(normalizedTarget, COMPOSER_PATH_SEARCH_DEBOUNCE_MS);
  const fileAccessSession = useEnvironmentQuery(
    debouncedTarget.environmentId === null
      ? null
      : environmentSession.sessionStateAtom(debouncedTarget.environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(debouncedTarget.environmentId);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const { canReadFiles } = fileAccess;
  const searchTarget =
    debouncedTarget.environmentId !== null &&
    debouncedTarget.cwd !== null &&
    debouncedTarget.query.length > 0
      ? {
          environmentId: debouncedTarget.environmentId,
          input: {
            cwd: debouncedTarget.cwd,
            query: debouncedTarget.query,
            limit: COMPOSER_PATH_SEARCH_LIMIT,
          },
        }
      : null;
  const result = useEnvironmentQuery(
    canReadFiles && searchTarget !== null ? projectEnvironment.searchEntries(searchTarget) : null,
  );
  const hasTarget = searchTarget !== null;

  return {
    entries: result.data?.entries ?? [],
    error:
      !hasTarget || fileAccess.isPending
        ? null
        : canReadFiles
          ? result.error
          : (fileAccess.error ?? "This connection cannot search host files."),
    isPending:
      normalizedTarget.query !== debouncedTarget.query ||
      (hasTarget && (fileAccess.isPending || result.isPending)),
    refresh: result.refresh,
  };
}

export function useCheckpointDiff(target: CheckpointDiffTarget) {
  const targets = buildCheckpointDiffTargets(target);
  const fullThread = useEnvironmentQuery(
    targets.fullThread === null
      ? null
      : orchestrationEnvironment.fullThreadDiff(targets.fullThread),
  );
  const turn = useEnvironmentQuery(
    targets.turn === null ? null : orchestrationEnvironment.turnDiff(targets.turn),
  );
  return targets.fullThread === null ? turn : fullThread;
}

export function useTurnItemDetail(
  target: {
    readonly environmentId: EnvironmentId;
    readonly row: OrchestrationV2ProjectedTurnItem;
  } | null,
) {
  return useEnvironmentQuery(
    target === null
      ? null
      : orchestrationEnvironment.turnItem({
          environmentId: target.environmentId,
          input: {
            threadId: target.row.sourceThreadId,
            itemId: target.row.sourceItemId,
            revision: turnItemDetailRevision(target.row.item),
          },
        }),
  );
}
