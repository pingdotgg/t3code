import {
  WS_METHODS,
  type EnvironmentId,
  type IssueAssigneeCandidate,
  type IssueCandidates,
  type IssueComment,
  type IssueCommentsPage,
  type IssueDetail,
  type IssueLabelCandidate,
  type IssueListEntry,
  type IssueListInput,
  type IssueListResult,
  type IssueRef,
  type IssueScopeRef,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  type AtomCommandResult,
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { request } from "../rpc/client.ts";

/** One row's identity across list pages and detail reads; hosts compare case-insensitively. */
export function issueEntryKey(
  entry: Pick<IssueListEntry, "projectId" | "host" | "scope" | "key">,
): string {
  return `${entry.projectId}\u0000${entry.host.toLowerCase()}\u0000${entry.scope.toLowerCase()}\u0000${entry.key}`;
}

/**
 * Lay a continuation page over the rows already held. A page only covers the scopes it was asked
 * to continue, so rows from other scopes stay; a row the page repeats replaces the held one, so a
 * title or state that moved between reads shows the newer words. Order stays newest-updated first,
 * which is how every tracker hands them over.
 */
export function mergeIssueListPage(
  held: ReadonlyArray<IssueListEntry>,
  page: ReadonlyArray<IssueListEntry>,
): ReadonlyArray<IssueListEntry> {
  if (held.length === 0) return page;
  if (page.length === 0) return held;
  const byKey = new Map<string, IssueListEntry>();
  for (const entry of held) byKey.set(issueEntryKey(entry), entry);
  for (const entry of page) byKey.set(issueEntryKey(entry), entry);
  return [...byKey.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** Older comments go in front: the detail carries the newest page and pages walk backwards. */
function prependIssueComments(
  current: ReadonlyArray<IssueComment>,
  older: ReadonlyArray<IssueComment>,
): ReadonlyArray<IssueComment> {
  if (older.length === 0) return current;
  const seen = new Set(current.map((comment) => comment.id));
  return [...older.filter((comment) => !seen.has(comment.id)), ...current];
}

export function createIssueCommentPager<E>(
  detailAtom: Atom.Atom<
    AsyncResult.AsyncResult<Pick<IssueDetail, "comments" | "commentsCursor">, E>
  >,
) {
  const state = Atom.make<{
    readonly older: (IssueCommentsPage & { readonly seed: string }) | null;
    readonly loadingOlder: boolean;
    readonly refreshing: boolean;
    readonly refreshes: number;
  }>({ older: null, loadingOlder: false, refreshing: false, refreshes: 0 });
  const page = Atom.make((get) => {
    const detailResult = get(detailAtom);
    const detail = AsyncResult.getOrElse(detailResult, () => null);
    const current = get(state);
    const seed = detail?.commentsCursor ?? null;
    const older = current.older?.seed === seed ? current.older : null;
    const nextCursor = older ? older.nextCursor : seed;
    return {
      comments: detail?.comments ?? [],
      seed,
      older,
      nextCursor,
      loadingOlder: current.loadingOlder,
      unavailable: detailResult.waiting || current.refreshing || current.loadingOlder,
    };
  });
  const view = Atom.make((get) => {
    const { comments, older, nextCursor, loadingOlder, unavailable } = get(page);
    return {
      comments: prependIssueComments(comments, older?.comments ?? []),
      nextCursor,
      loadingOlder,
      canLoadOlder: nextCursor !== null && !unavailable,
    };
  });

  return {
    view,
    /** `read` settles once the detail has been read again, whether or not that read failed. */
    async refresh(registry: AtomRegistry.AtomRegistry, read: () => Promise<unknown>) {
      const current = registry.get(state);
      if (current.refreshing) return;
      registry.set(state, { ...current, refreshing: true });
      let succeeded = false;
      try {
        await read();
        const result = registry.get(detailAtom);
        succeeded = result._tag === "Success" && !result.waiting;
      } finally {
        const latest = registry.get(state);
        // A successful read invalidates older pages even when the query reuses unchanged detail.
        registry.set(
          state,
          succeeded
            ? { ...latest, older: null, refreshing: false, refreshes: latest.refreshes + 1 }
            : { ...latest, refreshing: false },
        );
      }
    },
    async loadOlder(
      registry: AtomRegistry.AtomRegistry,
      read: (cursor: string) => Promise<AtomCommandResult<IssueCommentsPage, unknown>>,
    ) {
      const { seed, older, nextCursor, unavailable } = registry.get(page);
      if (seed === null || nextCursor === null || unavailable) return;
      const current = registry.get(state);
      registry.set(state, { ...current, loadingOlder: true });
      try {
        const result = await read(nextCursor);
        const latest = registry.get(state);
        if (latest.refreshes !== current.refreshes) return;
        if (result._tag === "Failure") return result;
        registry.set(state, {
          ...latest,
          older: {
            seed,
            comments: prependIssueComments(older?.comments ?? [], result.value.comments),
            nextCursor: result.value.nextCursor,
          },
        });
      } finally {
        registry.set(state, { ...registry.get(state), loadingOlder: false });
      }
    },
  };
}

type IssueListRefreshMode = "manual" | "background";

/**
 * Every read goes to a tracker API over the environment, so results are reused for a short while
 * and refreshed explicitly. Mutations run serially per environment: changes to one issue are
 * order-sensitive. Each confirmed write refreshes the detail it touched; the list is refreshed by
 * the page, which knows which listings it is showing.
 */
export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  const statusRefreshes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:status-refreshes",
    tag: WS_METHODS.issuesSubscribeStatusRefreshes,
  });
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:detail",
    tag: WS_METHODS.issuesDetail,
    staleTimeMs: 30_000,
    // An issue status rule saw this issue move, so an open detail reads it again.
    refreshTrigger: ({ environmentId, input }) =>
      statusRefreshes({
        environmentId,
        input: { tracker: input.tracker, key: input.key.toUpperCase() },
      }),
  });
  const detailRef = ({ projectId, tracker, host, scope, key }: IssueRef): IssueRef => ({
    projectId,
    tracker,
    ...(host === undefined ? {} : { host }),
    scope,
    key,
  });
  const refreshDetail = (
    { environmentId, input }: { readonly environmentId: EnvironmentId; readonly input: IssueRef },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(detail({ environmentId, input: detailRef(input) })));
  const linkedThreadSignals = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:linked-thread-refreshes",
    tag: WS_METHODS.pullRequestsSubscribeLinkedThreadRefreshes,
  });
  const pendingListRefreshes = new WeakMap<
    AtomRegistry.AtomRegistry,
    WeakMap<Atom.Atom<unknown>, symbol>
  >();
  type ListRequest = ReturnType<typeof request<typeof WS_METHODS.issuesList>>;
  const list = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:issues:list",
    staleTimeMs: 30_000,
    execute: Effect.fnUntraced(function* (
      input: IssueListInput,
    ): Effect.fn.Return<
      IssueListResult,
      Effect.Error<ListRequest>,
      Effect.Services<ListRequest> | AtomRegistry.AtomRegistry
    > {
      const registry = yield* AtomRegistry.AtomRegistry;
      const {
        target: { environmentId },
      } = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const pending = pendingListRefreshes.get(registry);
      if (pending === undefined) return yield* request(WS_METHODS.issuesList, input);
      const atom = list({ environmentId, input });
      const intent = pending.get(atom);
      if (intent === undefined) return yield* request(WS_METHODS.issuesList, input);
      return yield* request(WS_METHODS.issuesList, { ...input, refresh: true }).pipe(
        // Invalidation interrupts the read; its replacement still owes the explicit refresh.
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (!Exit.hasInterrupts(exit) && pending.get(atom) === intent) pending.delete(atom);
          }),
        ),
      );
    }),
  });
  return {
    /** The threads an issue is linked to, reread when the server signals a link changed. */
    linkedThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:linked-threads",
      tag: WS_METHODS.issuesLinkedThreads,
      staleTimeMs: 0,
      refreshTrigger: ({ environmentId }) => linkedThreadSignals({ environmentId, input: {} }),
    }),
    list,
    refreshList(
      registry: AtomRegistry.AtomRegistry,
      target: IssueListTarget,
      mode: IssueListRefreshMode,
    ) {
      const atom = list(target);
      if (mode === "manual") {
        let pending = pendingListRefreshes.get(registry);
        if (pending === undefined) {
          pending = new WeakMap();
          pendingListRefreshes.set(registry, pending);
        }
        pending.set(atom, Symbol());
      }
      registry.refresh(atom);
    },
    /**
     * A continuation of the listing, run as a command rather than read as a query: a page is
     * asked for once and laid over the rows held, and a refresh of the first page forgets it.
     */
    listPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:list-page",
      tag: WS_METHODS.issuesList,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    detail,
    /** Older comments past the cursor the detail handed over; the panel prepends what arrives. */
    comments: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:comments",
      tag: WS_METHODS.issuesComments,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.scope, input.key, input.cursor]),
      },
    }),
    /** Read when the composer opens: what a scope offers a new issue changes with a commit. */
    templates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:templates",
      tag: WS_METHODS.issuesTemplates,
      staleTimeMs: 5 * 60_000,
    }),
    /** Read when a label or assignee picker opens, not with every issue. */
    candidates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:candidates",
      tag: WS_METHODS.issuesCandidates,
      staleTimeMs: 60_000,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:create",
      tag: WS_METHODS.issuesCreate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:comment",
      tag: WS_METHODS.issuesComment,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshDetail,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:update",
      tag: WS_METHODS.issuesUpdate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshDetail,
    }),
    setState: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:set-state",
      tag: WS_METHODS.issuesSetState,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshDetail,
    }),
    react: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:react",
      tag: WS_METHODS.issuesReact,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshDetail,
    }),
  };
}

export interface IssueListTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
}

export interface MergedIssueList {
  /** One answer per environment that has one, in target order. */
  readonly answers: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>;
  /** The first environment that failed outright; the others may still have answered. */
  readonly error: string | null;
  readonly isPending: boolean;
}

const NO_ISSUE_LISTS: MergedIssueList = { answers: [], error: null, isPending: false };

function refreshFailed<Target, A, E>(
  registry: AtomRegistry.AtomRegistry,
  targets: ReadonlyArray<Target>,
  query: (target: Target) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  for (const target of targets) {
    const atom = query(target);
    const result = registry.get(atom);
    if (result._tag === "Failure" && !result.waiting) registry.refresh(atom);
  }
}

/**
 * One listing read across every environment at once: React cannot subscribe to a list of atoms
 * whose length changes, so the fan-out lives in one derived atom keyed by the targets. An
 * environment that fails contributes nothing rather than blanking the list. Retry reloads only
 * the environments that failed, so a read still in flight elsewhere is not restarted.
 */
export function createMergedIssueListAtoms<E>(
  {
    list,
    refreshList,
  }: {
    readonly list: (
      target: IssueListTarget,
    ) => Atom.Atom<AsyncResult.AsyncResult<IssueListResult, E>>;
    readonly refreshList: (
      registry: AtomRegistry.AtomRegistry,
      target: IssueListTarget,
      mode: IssueListRefreshMode,
    ) => void;
  },
  formatError: (cause: Cause.Cause<E>) => string,
) {
  const empty = Atom.make(NO_ISSUE_LISTS).pipe(Atom.withLabel("issues:merged-list:empty"));
  const family = Atom.family((key: string) =>
    Atom.make((get): MergedIssueList => {
      const answers: Array<readonly [EnvironmentId, IssueListResult]> = [];
      let error: string | null = null;
      let isPending = false;
      for (const target of JSON.parse(key) as ReadonlyArray<IssueListTarget>) {
        const result = get(list(target));
        isPending ||= result.waiting;
        if (result._tag === "Failure" && error === null) error = formatError(result.cause);
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) answers.push([target.environmentId, value]);
      }
      return { answers, error, isPending };
    }).pipe(Atom.withLabel(`issues:merged-list:${key}`)),
  );
  const refresh = (
    registry: AtomRegistry.AtomRegistry,
    targets: ReadonlyArray<IssueListTarget>,
    mode: IssueListRefreshMode,
  ) => {
    for (const target of targets) refreshList(registry, target, mode);
  };
  // The targets behind each listing atom, so a write made elsewhere can refresh the ones still
  // shown. Weak, so a closed search goes with its atom once the registry drops it.
  const targetsOf = new WeakMap<Atom.Atom<MergedIssueList>, ReadonlyArray<IssueListTarget>>();
  return {
    atom: (targets: ReadonlyArray<IssueListTarget>) => {
      if (targets.length === 0) return empty;
      const atom = family(JSON.stringify(targets));
      targetsOf.set(atom, targets);
      return atom;
    },
    refresh,
    retry: (registry: AtomRegistry.AtomRegistry, targets: ReadonlyArray<IssueListTarget>) =>
      refreshFailed(registry, targets, list),
    /** Refreshes each listing of `environmentId` that something still reads. */
    refreshEnvironment: (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
      for (const node of registry.getNodes().values()) {
        const targets = targetsOf.get(node.atom);
        if (targets === undefined) continue;
        refresh(
          registry,
          targets.filter((target) => target.environmentId === environmentId),
          "background",
        );
      }
    },
  };
}

export interface IssueCandidatesTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueScopeRef;
}

/** What a list filter can offer: the labels and people of every scope asked, each named once. */
export interface MergedIssueCandidates {
  readonly labels: ReadonlyArray<IssueLabelCandidate>;
  readonly assignees: ReadonlyArray<IssueAssigneeCandidate>;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly truncated: boolean;
}

const NO_ISSUE_CANDIDATES: MergedIssueCandidates = {
  labels: [],
  assignees: [],
  error: null,
  isPending: false,
  truncated: false,
};

/**
 * Fans out like the merged listing: a scope that fails leaves the others' answers in place.
 * Retry skips scopes that already answered or still have a request in flight.
 */
export function createMergedIssueCandidatesAtoms<E>(
  candidates: (
    target: IssueCandidatesTarget,
  ) => Atom.Atom<AsyncResult.AsyncResult<IssueCandidates, E>>,
  formatError: (cause: Cause.Cause<E>) => string,
) {
  const empty = Atom.make(NO_ISSUE_CANDIDATES).pipe(Atom.withLabel("issues:candidates:empty"));
  const family = Atom.family((key: string) =>
    Atom.make((get): MergedIssueCandidates => {
      const labels = new Map<string, IssueLabelCandidate>();
      const assignees = new Map<string, IssueAssigneeCandidate>();
      let error: string | null = null;
      let isPending = false;
      let truncated = false;
      for (const target of JSON.parse(key) as ReadonlyArray<IssueCandidatesTarget>) {
        const result = get(candidates(target));
        isPending ||= result.waiting;
        if (result._tag === "Failure" && error === null) error = formatError(result.cause);
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value === null) continue;
        truncated ||= value.truncated;
        for (const label of value.labels)
          if (!labels.has(label.name)) labels.set(label.name, label);
        for (const actor of value.assignees)
          if (!assignees.has(actor.login)) assignees.set(actor.login, actor);
      }
      return {
        labels: [...labels.values()].sort((a, b) => a.name.localeCompare(b.name)),
        assignees: [...assignees.values()].sort((a, b) => a.login.localeCompare(b.login)),
        error,
        isPending,
        truncated,
      };
    }).pipe(Atom.withLabel(`issues:candidates:${key}`)),
  );
  return {
    atom: (targets: ReadonlyArray<IssueCandidatesTarget>) =>
      targets.length === 0 ? empty : family(JSON.stringify(targets)),
    retry: (registry: AtomRegistry.AtomRegistry, targets: ReadonlyArray<IssueCandidatesTarget>) =>
      refreshFailed(registry, targets, candidates),
  };
}
