import { useAtomValue } from "@effect/atom-react";
import {
  type CheckpointDiffTarget,
  type ComposerPathSearchTarget,
} from "@t3tools/client-runtime/state/threads";
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
import { type VcsRefTarget } from "@t3tools/client-runtime/state/vcs";
import type {
  EnvironmentId,
  OrchestrationV2GetTurnItemResult,
  ProjectContentMatch,
  ProjectEntry,
  ProjectEntryKind,
  ThreadId,
  TurnItemId,
  VcsListRefsResult,
  VcsRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useFilesystemReadAccess } from "./filesystem";
import { orchestrationEnvironment } from "./orchestration";
import { olderSettledThreads, threadFamilies } from "./threads";
import { isPaginatedBranchesNextPagePending } from "./paginatedBranches";
import { projectContentSearch, projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";
import { vcsEnvironment } from "./vcs";

const PROJECT_PATH_SEARCH_DEBOUNCE_MS = 120;
const COMPOSER_PATH_SEARCH_LIMIT = 80;
const PROJECT_CONTENT_SEARCH_DEBOUNCE_MS = 120;
const PROJECT_CONTENT_SEARCH_LIMIT = 500;
const THREAD_SEARCH_DEBOUNCE_MS = 120;
const VCS_REF_LIST_LIMIT = 100;
const EMPTY_REFS: ReadonlyArray<VcsRef> = [];
const EMPTY_PROJECT_ENTRIES: ReadonlyArray<ProjectEntry> = [];
const EMPTY_CONTENT_MATCHES: ReadonlyArray<ProjectContentMatch> = [];
const INITIAL_BRANCH_CURSORS = [undefined] as const;
const EMPTY_THREAD_SEARCH_MATCHES: ReadonlyArray<EnvironmentThreadSearchMatch> = Object.freeze([]);
const EMPTY_THREAD_SEARCH_ATOM = Atom.make<ThreadSearchResultsState>({
  matches: EMPTY_THREAD_SEARCH_MATCHES,
  isLoading: false,
  rows: [],
}).pipe(Atom.withLabel("web:thread-search:empty"));

const olderSettledBeforeAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(olderSettledThreads.olderSettledAtom(environmentId))?.before ?? null).pipe(
    Atom.withLabel(`web:older-settled-before:${environmentId}`),
  ),
);
// Whether any of these environments leaves older settled threads out, so short queries matter.
const anyOlderSettledAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) =>
    (JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>).some(
      (environmentId) => get(olderSettledBeforeAtom(environmentId)) !== null,
    ),
  ).pipe(Atom.withLabel(`web:any-older-settled:${environmentIdsKey}`)),
);
const threadSearch = createThreadSearchResultsAtomFamily({
  getSearchAtom: (environmentId, input) =>
    input.olderSettledBefore === undefined
      ? orchestrationEnvironment.threadSearch({ environmentId, input })
      : olderSettledThreads.searchAtom(environmentId, input),
  olderSettledBefore: olderSettledBeforeAtom,
  labelPrefix: "web:thread-search",
});

export function useDebouncedValue<A>(value: A, delayMs: number): A {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [delayMs, value]);

  return debounced;
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

function vcsRefPageAtom(targetKey: string, cursor: number | undefined) {
  const [environmentId, cwd, query] = JSON.parse(targetKey) as [EnvironmentId, string, string];
  return vcsEnvironment.listRefs({
    environmentId,
    input: {
      cwd,
      ...(query.length > 0 ? { query } : {}),
      ...(cursor === undefined ? {} : { cursor }),
      limit: VCS_REF_LIST_LIMIT,
    },
  });
}

const EMPTY_VCS_REF_PAGES_ATOM = Atom.make<
  ReadonlyArray<Atom.Type<ReturnType<typeof vcsRefPageAtom>>>
>([]).pipe(Atom.withLabel("web:vcs-ref-pages:empty"));

const vcsRefPagesAtom = Atom.family((pagesKey: string) => {
  const [targetKey, cursors] = JSON.parse(pagesKey) as [string, Array<number | null>];
  const pageAtoms = cursors.map((cursor) => vcsRefPageAtom(targetKey, cursor ?? undefined));
  return Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
    Atom.withLabel(`web:vcs-ref-pages:${pagesKey}`),
  );
});

export function usePaginatedBranches(target: VcsRefTarget) {
  // Leave unkeyed; mismatches already reset cursors, and a seeded key would break caching across the hook.
  const [pagination, setPagination] = useState<{
    readonly targetKey: string | null;
    readonly cursors: ReadonlyArray<number | undefined>;
  }>({
    targetKey: null,
    cursors: INITIAL_BRANCH_CURSORS,
  });
  const { environmentId, cwd } = target;
  const query = target.query?.trim() ?? "";
  const targetKey =
    environmentId !== null && cwd !== null ? JSON.stringify([environmentId, cwd, query]) : null;
  const cursors = pagination.targetKey === targetKey ? pagination.cursors : INITIAL_BRANCH_CURSORS;
  const pagesKey = targetKey === null ? null : JSON.stringify([targetKey, cursors]);
  const results = useAtomValue(
    pagesKey === null ? EMPTY_VCS_REF_PAGES_ATOM : vcsRefPagesAtom(pagesKey),
  );
  const values = results.flatMap((result) => {
    const value = Option.getOrNull(AsyncResult.value(result));
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
  const failed = results.find((result) => result._tag === "Failure");
  const isFetchingNextPage = isPaginatedBranchesNextPagePending(results);
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
    setPagination({ targetKey, cursors: INITIAL_BRANCH_CURSORS });
    if (targetKey !== null) {
      appAtomRegistry.refresh(vcsRefPageAtom(targetKey, undefined));
    }
  };
  const nextCursor = data?.nextCursor;
  const loadNext = () => {
    if (targetKey === null || nextCursor === null || nextCursor === undefined) {
      return;
    }
    setPagination((current) => {
      const currentCursors =
        current.targetKey === targetKey ? current.cursors : INITIAL_BRANCH_CURSORS;
      return currentCursors.includes(nextCursor)
        ? { targetKey, cursors: currentCursors }
        : { targetKey, cursors: [...currentCursors, nextCursor] };
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

type ProjectPathSearchTarget = ComposerPathSearchTarget & {
  readonly kind?: ProjectEntryKind | undefined;
  readonly imageOnly?: boolean | undefined;
};

function areProjectPathSearchTargetsEqual(
  left: ProjectPathSearchTarget,
  right: ProjectPathSearchTarget,
): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.cwd === right.cwd &&
    left.query === right.query &&
    left.kind === right.kind &&
    left.imageOnly === right.imageOnly
  );
}

export function useProjectPathSearch(
  target: ProjectPathSearchTarget,
  limit: number,
  options?: { readonly allowEmptyQuery?: boolean },
) {
  const allowEmptyQuery = options?.allowEmptyQuery === true;
  const normalizedTarget = {
    environmentId: target.environmentId,
    cwd: target.cwd,
    query: target.query == null ? null : target.query.trim(),
    kind: target.kind,
    imageOnly: target.imageOnly,
  };
  const debouncedTarget = useDebouncedValue(normalizedTarget, PROJECT_PATH_SEARCH_DEBOUNCE_MS);
  const fileAccess = useFilesystemReadAccess(debouncedTarget.environmentId);
  const { canReadFiles } = fileAccess;
  const searchTarget =
    debouncedTarget.environmentId !== null &&
    debouncedTarget.cwd !== null &&
    debouncedTarget.query !== null &&
    (allowEmptyQuery || debouncedTarget.query.length > 0)
      ? {
          environmentId: debouncedTarget.environmentId,
          input: {
            cwd: debouncedTarget.cwd,
            query: debouncedTarget.query,
            limit,
            ...(debouncedTarget.kind ? { kind: debouncedTarget.kind } : {}),
            ...(debouncedTarget.imageOnly ? { imageOnly: true } : {}),
          },
        }
      : null;
  const result = useEnvironmentQuery(
    canReadFiles && searchTarget !== null ? projectEnvironment.searchEntries(searchTarget) : null,
  );
  const hasTarget = searchTarget !== null;

  return {
    entries: result.data?.entries ?? EMPTY_PROJECT_ENTRIES,
    error:
      !hasTarget || fileAccess.isPending
        ? null
        : canReadFiles
          ? result.error
          : (fileAccess.error ?? "This connection cannot search host files."),
    isPending:
      !areProjectPathSearchTargetsEqual(normalizedTarget, debouncedTarget) ||
      (hasTarget && (fileAccess.isPending || result.isPending)),
    searchedTarget: debouncedTarget,
    searchedQuery: debouncedTarget.query ?? "",
    truncated: result.data?.truncated ?? false,
    refresh: result.refresh,
  };
}

export function useComposerPathSearch(target: ComposerPathSearchTarget) {
  return useProjectPathSearch(target, COMPOSER_PATH_SEARCH_LIMIT);
}

interface ProjectContentSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly useRegex: boolean;
}

export function useProjectContentSearch(target: ProjectContentSearchTarget) {
  const hasTarget = target.environmentId !== null && target.cwd !== null;
  const fileAccess = useFilesystemReadAccess(target.environmentId);
  const canReadFiles = hasTarget && fileAccess.canReadFiles;
  const isCheckingAccess = hasTarget && fileAccess.isPending;
  // Preserve query whitespace; trim only to detect blank input.
  const query = target.query;
  const hasQuery = query.trim().length > 0;
  const debouncedQuery = useDebouncedValue(query, PROJECT_CONTENT_SEARCH_DEBOUNCE_MS);
  const result = useEnvironmentQuery(
    canReadFiles &&
      target.environmentId !== null &&
      target.cwd !== null &&
      hasQuery &&
      debouncedQuery.trim().length > 0
      ? projectContentSearch({
          environmentId: target.environmentId,
          input: {
            cwd: target.cwd,
            query: debouncedQuery,
            limit: PROJECT_CONTENT_SEARCH_LIMIT,
            caseSensitive: target.caseSensitive,
            wholeWord: target.wholeWord,
            useRegex: target.useRegex,
          },
        })
      : null,
  );

  return {
    canReadFiles,
    isCheckingAccess,
    matches: result.data?.matches ?? EMPTY_CONTENT_MATCHES,
    error:
      !hasTarget || isCheckingAccess
        ? null
        : canReadFiles
          ? result.error
          : (fileAccess.error ?? "This connection cannot search host files."),
    isPending:
      isCheckingAccess ||
      (canReadFiles && hasQuery && (query !== debouncedQuery || result.isPending)),
    hasQuery,
    truncated: result.data?.truncated ?? false,
    invalidRegex: target.useRegex && result.data?.regexFallbackError !== undefined,
  };
}

export function useCheckpointDiff(
  target: CheckpointDiffTarget,
  options?: { readonly enabled?: boolean },
) {
  const enabled =
    options?.enabled !== false &&
    target.environmentId !== null &&
    target.threadId !== null &&
    target.fromTurnCount !== null &&
    target.toTurnCount !== null;
  const fullThreadTarget =
    enabled && target.fromTurnCount === 0
      ? {
          environmentId: target.environmentId!,
          input: {
            threadId: target.threadId!,
            toTurnCount: target.toTurnCount!,
            ignoreWhitespace: target.ignoreWhitespace,
          },
        }
      : null;
  const turnTarget =
    enabled && target.fromTurnCount !== 0
      ? {
          environmentId: target.environmentId!,
          input: {
            threadId: target.threadId!,
            fromTurnCount: target.fromTurnCount!,
            toTurnCount: target.toTurnCount!,
            ignoreWhitespace: target.ignoreWhitespace,
          },
        }
      : null;
  const fullThread = useEnvironmentQuery(
    fullThreadTarget === null ? null : orchestrationEnvironment.fullThreadDiff(fullThreadTarget),
  );
  const turn = useEnvironmentQuery(
    turnTarget === null ? null : orchestrationEnvironment.turnDiff(turnTarget),
  );
  return fullThreadTarget === null ? turn : fullThread;
}

/** Reads one item's detail from somewhere other than the environment, as the guest page does. */
export type TurnItemDetailSource = (input: {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
}) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2GetTurnItemResult, unknown>>;

export function useTurnItemDetail(
  target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
    readonly revision: string;
  } | null,
  source?: TurnItemDetailSource,
) {
  const input =
    target === null
      ? null
      : { threadId: target.threadId, itemId: target.itemId, revision: target.revision };
  return useEnvironmentQuery<OrchestrationV2GetTurnItemResult, unknown>(
    target === null || input === null
      ? null
      : source
        ? source(input)
        : orchestrationEnvironment.turnItem({ environmentId: target.environmentId, input }),
  );
}
