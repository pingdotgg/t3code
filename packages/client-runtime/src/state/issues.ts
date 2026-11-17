import {
  WS_METHODS,
  type EnvironmentId,
  type IssueAssigneeCandidate,
  type IssueCandidates,
  type IssueComment,
  type IssueLabelCandidate,
  type IssueListEntry,
  type IssueListInput,
  type IssueListResult,
  type IssueRef,
  type IssueScopeRef,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

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
export function prependIssueComments(
  current: ReadonlyArray<IssueComment>,
  older: ReadonlyArray<IssueComment>,
): ReadonlyArray<IssueComment> {
  if (older.length === 0) return current;
  const seen = new Set(current.map((comment) => comment.id));
  return [...older.filter((comment) => !seen.has(comment.id)), ...current];
}

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
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:detail",
    tag: WS_METHODS.issuesDetail,
    staleTimeMs: 30_000,
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
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:list",
      tag: WS_METHODS.issuesList,
      staleTimeMs: 30_000,
    }),
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

/**
 * One listing read across every environment at once: React cannot subscribe to a list of atoms
 * whose length changes, so the fan-out lives in one derived atom keyed by the targets. An
 * environment that fails contributes nothing rather than blanking the list.
 */
export function createMergedIssueListAtoms<E>(
  list: (target: IssueListTarget) => Atom.Atom<AsyncResult.AsyncResult<IssueListResult, E>>,
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
  ) => {
    for (const target of targets) registry.refresh(list(target));
  };
  // Every listing asked for, so a write made elsewhere can refresh the ones still shown.
  const asked = new Map<string, ReadonlyArray<IssueListTarget>>();
  return {
    atom: (targets: ReadonlyArray<IssueListTarget>) => {
      if (targets.length === 0) return empty;
      const key = JSON.stringify(targets);
      asked.set(key, targets);
      return family(key);
    },
    refresh,
    /** Refreshes each listing of `environmentId` that something still reads. */
    refreshEnvironment: (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
      const live = new Set(registry.getNodes().keys());
      for (const [key, targets] of asked) {
        if (!live.has(family(key))) continue;
        refresh(
          registry,
          targets.filter((target) => target.environmentId === environmentId),
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

/** Fans out like the merged listing: a scope that fails leaves the others' answers in place. */
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
  return (targets: ReadonlyArray<IssueCandidatesTarget>) =>
    targets.length === 0 ? empty : family(JSON.stringify(targets));
}
