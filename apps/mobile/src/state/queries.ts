import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "@t3tools/client-runtime/thread-pull-requests";
import {
  composerExactPullRequestRepositories,
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
  PullRequestDetail,
  PullRequestRef,
  ThreadPullRequestLink,
  VcsListRefsInput,
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
import { PullRequestOperationError, THREAD_SEARCH_QUERY_MAX_LENGTH } from "@t3tools/contracts";
import { messageSearchTokens } from "@t3tools/shared/paletteSearch";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";

import { appAtomRegistry } from "./atom-registry";
import { orchestrationEnvironment } from "./orchestration";
import { olderSettledThreads, threadFamilies } from "./threads";
import { projectEnvironment } from "./projects";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";
import { msg, useMessages } from "gt-react-native";
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
  failed: false,
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

const EMPTY_PULL_REQUEST_DETAILS_ATOM = Atom.make<{
  readonly details: ReadonlyArray<PullRequestDetail>;
  readonly failureCause: Cause.Cause<unknown> | null;
  readonly isPending: boolean;
}>({ details: [], failureCause: null, isPending: false }).pipe(
  Atom.withLabel("mobile:composer-pr-details:empty"),
);

const isPullRequestOperationError = Schema.is(PullRequestOperationError);

function isPullRequestNotFoundCause(cause: Cause.Cause<unknown>): boolean {
  const failure = Option.getOrNull(Cause.findErrorOption(cause));
  return isPullRequestOperationError(failure) && failure.reason === "not-found";
}

const composerPullRequestDetailsAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const targets = JSON.parse(key) as ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly input: PullRequestRef;
    }>;
    const details: PullRequestDetail[] = [];
    let failureCause: Cause.Cause<unknown> | null = null;
    let isPending = false;
    for (const target of targets) {
      const result = get(composerPullRequests.detail(target));
      isPending ||= result.waiting;
      if (
        result._tag === "Failure" &&
        failureCause === null &&
        !isPullRequestNotFoundCause(result.cause)
      ) {
        failureCause = result.cause;
      }
      const value = AsyncResult.getOrElse(result, () => null);
      if (value !== null) details.push(value);
    }
    return { details, failureCause, isPending };
  }).pipe(Atom.withLabel(`mobile:composer-pr-details:${key}`)),
);

export function useComposerPullRequestSearch(input: {
  environmentId: EnvironmentId | null;
  projectId: ProjectId | null;
  repository: string | null;
  hasTrackedFolders?: boolean;
  threadPullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  query: string | null;
}) {
  const resolve = useMessages();
  const query = useDebouncedValue(input.query, 180);
  const linked =
    input.projectId === null
      ? []
      : composerPullRequestsFromLinks(input.threadPullRequests ?? [], input.projectId);
  const hasSource =
    input.projectId !== null && (input.repository !== null || input.hasTrackedFolders === true);
  const ready =
    query === input.query && query !== null && input.environmentId !== null && hasSource;
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
  const exactTargets =
    ready &&
    number !== null &&
    Number.isSafeInteger(number) &&
    number > 0 &&
    (input.repository !== null || list.data !== null)
      ? composerExactPullRequestRepositories({
          projectId: input.projectId!,
          repository: input.repository,
          listedRepositories: list.data?.repositories,
          entries: list.data?.entries ?? [],
          number,
        }).map(({ host, repository }) => ({
          environmentId: input.environmentId!,
          input: {
            projectId: input.projectId!,
            ...(host === undefined ? {} : { host }),
            repository,
            number,
          },
        }))
      : [];
  const exact = useAtomValue(
    exactTargets.length === 0
      ? EMPTY_PULL_REQUEST_DETAILS_ATOM
      : composerPullRequestDetailsAtom(JSON.stringify(exactTargets)),
  );
  // Only the host: the URL's full repository path would not match the project's selector.
  const exactEntries = exact.details
    .filter((detail) => detail.number === number)
    .map((detail) => ({ ...detail, host: legacyThreadPullRequestKey(detail).host }));
  const normalizedRepository = input.repository?.trim().toLowerCase() ?? null;
  const entries = (() => {
    if (input.query === null || input.projectId === null || !hasSource) return [];
    if (/^\d*$/.test(input.query)) {
      return filterComposerPullRequestMatches({
        keyOf: threadPullRequestKeyOf,
        entries: ready ? [...exactEntries, ...(list.data?.entries ?? [])] : [],
        linked,
        projectId: input.projectId,
        repository: input.repository,
        query: input.query,
        limit: 20,
      });
    }
    if (!ready) {
      return withLinkedComposerPullRequestsFirst({
        keyOf: threadPullRequestKeyOf,
        matches: [],
        linked,
        query: input.query,
        limit: 20,
      });
    }
    const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const found = [...exactEntries, ...(list.data?.entries ?? [])].filter(
      (entry) =>
        entry.projectId === input.projectId &&
        (normalizedRepository === null ||
          entry.repository.trim().toLowerCase() === normalizedRepository) &&
        words.every((word) =>
          `${entry.title} ${entry.headBranch} ${entry.baseBranch}`.toLowerCase().includes(word),
        ),
    );
    const unique = new Map<string, (typeof found)[number]>();
    for (const entry of found) {
      const key = threadPullRequestKeyOf(entry);
      if (!unique.has(key)) unique.set(key, entry);
    }
    return withLinkedComposerPullRequestsFirst({
      keyOf: threadPullRequestKeyOf,
      matches: [...unique.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
      linked,
      query: query ?? "",
      limit: 20,
    });
  })();
  const unavailable =
    input.repository === null &&
    list.data !== null &&
    list.error === null &&
    list.data.providers.length === 0 &&
    list.data.entries.length === 0 &&
    list.data.errors.length === 0;
  const exactError =
    exact.failureCause === null ? null : formatEnvironmentQueryError(exact.failureCause, resolve);
  return {
    entries,
    isPending:
      input.query !== null &&
      hasSource &&
      (query !== input.query || list.isPending || exact.isPending),
    error: list.error ?? list.data?.errors[0]?.message ?? exactError,
    unavailable,
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
  /** No environment could run the search for the current query, so an empty result is not "no matches". */
  readonly failed: boolean;
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
  const failed = settledQuery !== null && !result.isLoading && result.failed;
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
    failed,
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

export function usePaginatedBranches(
  target: VcsRefTarget & { readonly refKind?: VcsListRefsInput["refKind"] },
) {
  const resolve = useMessages();
  const query = target.query?.trim() ?? "";
  const { refKind } = target;
  const targetKey =
    target.environmentId !== null && target.cwd !== null
      ? JSON.stringify([target.environmentId, target.cwd, query, refKind])
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
                ...(refKind === undefined ? {} : { refKind }),
                limit: VCS_REF_LIST_LIMIT,
              },
            }),
          )
        : [],
    [target.environmentId, target.cwd, query, refKind, cursors],
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
            : resolve(msg("Failed to load refs."));
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
  const resolve = useMessages();
  const query = normalizeComposerPathSearchQuery(target.query);
  const normalizedTarget = { environmentId: target.environmentId, cwd: target.cwd, query };
  const debouncedTarget = useDebouncedValue(normalizedTarget, COMPOSER_PATH_SEARCH_DEBOUNCE_MS);
  const fileAccessSession = useEnvironmentQuery(
    debouncedTarget.environmentId === null
      ? null
      : environmentSession.sessionStateAtom(debouncedTarget.environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(debouncedTarget.environmentId);
  const fileAccess = resolveFilesystemReadAccess(
    {
      isCatalogReady: fileEnvironment.isReady,
      connection: fileEnvironment.presentation?.connection ?? null,
      session: fileAccessSession.data,
      sessionError: fileAccessSession.error,
    },
    resolve,
  );
  const { canReadFiles } = fileAccess;
  const searchTarget =
    debouncedTarget.environmentId !== null &&
    debouncedTarget.cwd !== null &&
    debouncedTarget.query !== null
      ? {
          environmentId: debouncedTarget.environmentId,
          input: {
            cwd: debouncedTarget.cwd,
            query: debouncedTarget.query.slice(0, 256).replace(/[\uD800-\uDBFF]$/, ""),
            limit: COMPOSER_PATH_SEARCH_LIMIT,
          },
        }
      : null;
  const result = useEnvironmentQuery(
    canReadFiles && searchTarget !== null ? projectEnvironment.searchEntries(searchTarget) : null,
  );
  const hasTarget = searchTarget !== null;
  const isSameCheckout =
    normalizedTarget.environmentId === debouncedTarget.environmentId &&
    normalizedTarget.cwd === debouncedTarget.cwd;

  return {
    // Entries from another checkout must not be offered while the new one is debounced.
    entries: isSameCheckout ? (result.data?.entries ?? []) : [],
    error:
      !hasTarget || fileAccess.isPending
        ? null
        : canReadFiles
          ? result.error
          : (fileAccess.error ?? resolve(msg("This connection cannot search host files."))),
    isPending:
      !isSameCheckout ||
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
