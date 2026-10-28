import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { isProviderNativeSubagentThread, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import type { EnvironmentThreadShell, PendingSubagentRequest } from "./models.ts";
import { presentThreadShell, threadRuntimeIsActive } from "./models.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import {
  arrayElementsEqual,
  parseProjectRefCollectionKey,
  parseThreadKey,
  projectRefCollectionKey,
  threadKey,
  threadRefsEqual,
} from "./entities.ts";

const EMPTY_THREADS: ReadonlyArray<OrchestrationV2ThreadShell> = Object.freeze([]);
const EMPTY_SCOPED_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);
const EMPTY_THREAD_INDEX: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> = new Map();
const EMPTY_SUBAGENT_REQUESTS: ReadonlyMap<ThreadId, PendingSubagentRequest> = new Map();
const EMPTY_THREAD_REFS_BY_PROJECT: ReadonlyMap<
  ProjectId,
  ReadonlyArray<ScopedThreadRef>
> = new Map();

// An async question outlives the subagent's run, but once that run ends the
// parent is no longer waiting on the answer, so it stops counting as input.
// The activity run stays set when a follow-up is queued behind a blocked run;
// older servers omit it, so fall back to the latest run's status.
const isChildRunLive = (
  thread: Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "status">,
) =>
  thread.activityRunStatus !== undefined
    ? thread.activityRunStatus !== null
    : thread.status === "preparing" ||
      thread.status === "starting" ||
      thread.status === "running" ||
      thread.status === "waiting";

/**
 * Whether a thread shows under its parent rather than in thread lists: a
 * subagent, or a task a linked environment delegated here whose parent the
 * client lists (`delegatedUnderParent`, by thread key). A task whose parent
 * the client cannot list stays in the lists, so its work is never out of reach.
 */
export function isShownUnderParent(
  ref: ScopedThreadRef,
  lineage: OrchestrationV2ThreadShell["lineage"],
  delegatedUnderParent: ReadonlySet<string>,
): boolean {
  return lineage.relationshipToParent === "subagent" || delegatedUnderParent.has(threadKey(ref));
}

/** Provider-native
    subagents ask on their parent, so they are skipped. */
function subagentRequest(thread: OrchestrationV2ThreadShell): PendingSubagentRequest | null {
  const kind = thread.pendingRuntimeRequest?.kind;
  if (
    kind === undefined ||
    kind === "auth_refresh" ||
    (thread.lineage.relationshipToParent !== "subagent" && thread.delegatedFrom === undefined) ||
    isProviderNativeSubagentThread(thread) ||
    !isChildRunLive(thread)
  ) {
    return null;
  }
  return kind === "user_input" ? "user_input" : "approval";
}

/**
 * The threads to flag for a subagent's live approval, up its
 * subagent chain. `delegated` are tasks this environment's threads delegated
 * to linked environments, with what each one, or its own subagents, asks.
 */
function pendingSubagentRequestsByThread(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  delegated: ReadonlyArray<{
    readonly parentThreadId: ThreadId;
    readonly request: PendingSubagentRequest;
  }> = [],
): ReadonlyMap<ThreadId, PendingSubagentRequest> {
  const requests = new Map<ThreadId, PendingSubagentRequest>();
  let byId: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> | undefined;
  const flag = (
    firstParentId: ThreadId | null,
    request: PendingSubagentRequest,
    seen: Set<ThreadId>,
  ) => {
    // The coordinator answers child questions; only approvals need user attention.
    if (request === "user_input") return;
    byId ??= new Map(threads.map((thread) => [thread.id, thread] as const));
    let parentId = firstParentId;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      if (requests.get(parentId) !== "approval") requests.set(parentId, request);
      const parent = byId.get(parentId);
      parentId =
        parent?.lineage.relationshipToParent === "subagent" ? parent.lineage.parentThreadId : null;
    }
  };
  for (const child of threads) {
    if (child.lineage.relationshipToParent !== "subagent") continue;
    const request = subagentRequest(child);
    if (request !== null) flag(child.lineage.parentThreadId, request, new Set([child.id]));
  }
  for (const task of delegated) flag(task.parentThreadId, task.request, new Set());
  return requests.size === 0 ? EMPTY_SUBAGENT_REQUESTS : requests;
}

const sameRequests = (
  left: ReadonlyMap<ThreadId, PendingSubagentRequest>,
  right: ReadonlyMap<ThreadId, PendingSubagentRequest>,
) =>
  left.size === right.size &&
  [...right].every(([threadId, request]) => left.get(threadId) === request);

export function childThreadInputsTitle(
  children: ReadonlyArray<Pick<EnvironmentThreadShell, "hasPendingApprovals">>,
): string {
  const approvals = children.filter((child) => child.hasPendingApprovals).length;
  const need = approvals === 0 ? "input" : approvals === children.length ? "approval" : "you";
  return children.length === 1
    ? `Subagent needs ${need}`
    : `${children.length} subagents need ${need}`;
}

const sameWireThreadShell = Schema.toEquivalence(OrchestrationV2ThreadShell);

// While a run streams, the server bumps the shell's timestamps, item counts and
// latest message several times a second. Only the zero crossing of the counts
// says anything (whether the thread has started). Once the run stops every
// field counts again, so snooze wakes and failure times read the current value.
function sameApartFromStreaming(
  previous: EnvironmentThreadShell,
  next: EnvironmentThreadShell,
): boolean {
  if (
    previous.environmentId !== next.environmentId ||
    previous.pendingSubagentRequest !== next.pendingSubagentRequest ||
    !threadRuntimeIsActive(next.runtime)
  ) {
    return false;
  }
  const before = previous.source;
  const after = next.source;
  return (
    before.itemCount > 0 === after.itemCount > 0 &&
    before.visibleItemCount > 0 === after.visibleItemCount > 0 &&
    sameWireThreadShell(
      {
        ...before,
        updatedAt: after.updatedAt,
        itemCount: after.itemCount,
        visibleItemCount: after.visibleItemCount,
        latestVisibleMessage: after.latestVisibleMessage,
      },
      after,
    )
  );
}

export function createEnvironmentThreadShellAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
}) {
  // Point reads and aggregate lists share values without keeping an atom alive
  // for every listed thread. Replaced source objects can be collected.
  const scopedThreads = new WeakMap<
    OrchestrationV2ThreadShell,
    Map<string, EnvironmentThreadShell>
  >();
  const scopedThread = (
    environmentId: EnvironmentId,
    thread: OrchestrationV2ThreadShell,
    subagentRequests: ReadonlyMap<ThreadId, PendingSubagentRequest>,
  ) => {
    let byEnvironment = scopedThreads.get(thread);
    if (byEnvironment === undefined) {
      byEnvironment = new Map();
      scopedThreads.set(thread, byEnvironment);
    }
    const request = subagentRequests.get(thread.id) ?? null;
    const key = request === null ? environmentId : `${environmentId}:${request}`;
    let value = byEnvironment.get(key);
    if (value === undefined) {
      value = presentThreadShell(environmentId, thread, request);
      byEnvironment.set(key, value);
    }
    return value;
  };

  const environmentThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationV2ThreadShell> =>
        get(input.snapshotAtom(environmentId))?.threads ?? EMPTY_THREADS,
    ).pipe(Atom.withLabel(`environment-threads:${environmentId}`)),
  );

  const environmentThreadIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> => {
      const threads = get(environmentThreadsAtom(environmentId));
      if (threads.length === 0) {
        return EMPTY_THREAD_INDEX;
      }
      return new Map(threads.map((thread) => [thread.id, thread] as const));
    }).pipe(Atom.withLabel(`environment-thread-index:${environmentId}`)),
  );

  // What an environment's own subagents ask. Kept apart from the tasks other
  // environments run for it, so two environments delegating to each other
  // never read each other's totals.
  const localSubagentRequestsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous = EMPTY_SUBAGENT_REQUESTS;
    return Atom.make((get) => {
      const next = pendingSubagentRequestsByThread(get(environmentThreadsAtom(environmentId)));
      if (sameRequests(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-local-subagent-requests:${environmentId}`));
  });

  // Flags for environments whose threads delegated tasks, counting what each task
  // or anything it delegated on asks. Each pass settles one more hop of a chain;
  // flags only grow, so environments delegating to each other settle too.
  const delegatedSubagentRequestsAtom = Atom.make((get) => {
    const tasksByDelegator = new Map<
      EnvironmentId,
      Array<{
        readonly runsIn: EnvironmentId;
        readonly thread: OrchestrationV2ThreadShell;
        readonly parentThreadId: ThreadId;
      }>
    >();
    for (const runsIn of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      for (const thread of get(environmentThreadsAtom(runsIn))) {
        const from = thread.delegatedFrom;
        if (from === undefined || from.environmentId === runsIn) continue;
        const task = { runsIn, thread, parentThreadId: from.threadId };
        const tasks = tasksByDelegator.get(from.environmentId);
        if (tasks === undefined) tasksByDelegator.set(from.environmentId, [task]);
        else tasks.push(task);
      }
    }
    let flags = new Map<EnvironmentId, ReadonlyMap<ThreadId, PendingSubagentRequest>>();
    const requestsOf = (environmentId: EnvironmentId) =>
      flags.get(environmentId) ?? get(localSubagentRequestsAtom(environmentId));
    for (let changed = tasksByDelegator.size > 0; changed;) {
      changed = false;
      const next = new Map(flags);
      for (const [environmentId, tasks] of tasksByDelegator) {
        const delegated = tasks.flatMap(({ runsIn, thread, parentThreadId }) => {
          const own = subagentRequest(thread);
          const nested = requestsOf(runsIn).get(thread.id);
          const request = own === "approval" ? own : (nested ?? own);
          return request === null ? [] : [{ parentThreadId, request }];
        });
        if (delegated.length === 0) continue;
        const requests = pendingSubagentRequestsByThread(
          get(environmentThreadsAtom(environmentId)),
          delegated,
        );
        if (sameRequests(requestsOf(environmentId), requests)) continue;
        next.set(environmentId, requests);
        changed = true;
      }
      flags = next;
    }
    return flags;
  }).pipe(Atom.withLabel("environment-delegated-subagent-requests"));

  const pendingSubagentRequestsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous = EMPTY_SUBAGENT_REQUESTS;
    return Atom.make((get) => {
      const next =
        get(delegatedSubagentRequestsAtom).get(environmentId) ??
        get(localSubagentRequestsAtom(environmentId));
      if (sameRequests(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-pending-subagent-requests:${environmentId}`));
  });

  const environmentThreadRefsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ScopedThreadRef> = [];
    return Atom.make((get) => {
      const next = get(environmentThreadsAtom(environmentId)).map((thread) => ({
        environmentId,
        threadId: thread.id,
      }));
      if (threadRefsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-thread-refs:${environmentId}`));
  });

  const environmentThreadRefsByProjectAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyMap<
      ProjectId,
      ReadonlyArray<ScopedThreadRef>
    > = EMPTY_THREAD_REFS_BY_PROJECT;
    return Atom.make((get) => {
      const grouped = new Map<ProjectId, ScopedThreadRef[]>();
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        const refs = grouped.get(thread.projectId);
        const ref = { environmentId, threadId: thread.id };
        if (refs === undefined) {
          grouped.set(thread.projectId, [ref]);
        } else {
          refs.push(ref);
        }
      }
      if (grouped.size === 0) {
        previous = EMPTY_THREAD_REFS_BY_PROJECT;
        return previous;
      }
      const next = new Map<ProjectId, ReadonlyArray<ScopedThreadRef>>();
      for (const [projectId, refs] of grouped) {
        const previousRefs = previous.get(projectId);
        next.set(
          projectId,
          previousRefs !== undefined && threadRefsEqual(previousRefs, refs) ? previousRefs : refs,
        );
      }
      const previousProjectIds = [...previous.keys()];
      if (
        next.size === previous.size &&
        [...next].every(
          ([projectId, refs], index) =>
            previousProjectIds[index] === projectId && previous.get(projectId) === refs,
        )
      ) {
        return previous;
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-refs-by-project:${environmentId}`));
  });

  const threadShellAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) => {
      const source = get(environmentThreadIndexAtom(ref.environmentId)).get(ref.threadId) ?? null;
      return source === null
        ? null
        : scopedThread(
            ref.environmentId,
            source,
            get(pendingSubagentRequestsAtom(ref.environmentId)),
          );
    }).pipe(Atom.withLabel(`environment-thread-shell:${key}`));
  });

  // Keeps the previous shell while only streaming ticks changed. During a run,
  // its timestamps, item counts and latest message are as of the last kept
  // change; anything that needs them current reads threadShellAtom.
  const quietThreadShellAtomFamily = Atom.family((key: string) => {
    let previous: EnvironmentThreadShell | null = null;
    return Atom.make((get) => {
      const next = get(threadShellAtomFamily(key));
      if (previous !== null && next !== null && sameApartFromStreaming(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-quiet-thread-shell:${key}`));
  });

  // Child approvals and questions are hidden with their sidebar rows. Read their
  // shell summaries, without subscribing to every child transcript. A task
  // delegated to a linked environment is a child too, with its own subagents.
  const childThreadInputsAtomFamily = Atom.family((key: string) => {
    let previous: ReadonlyArray<EnvironmentThreadShell> = [];
    return Atom.make((get) => {
      const children = new Map<
        string,
        Array<{ environmentId: EnvironmentId; thread: OrchestrationV2ThreadShell }>
      >();
      const addChild = (
        parent: ScopedThreadRef,
        environmentId: EnvironmentId,
        thread: OrchestrationV2ThreadShell,
      ) => {
        const siblings = children.get(threadKey(parent));
        if (siblings) siblings.push({ environmentId, thread });
        else children.set(threadKey(parent), [{ environmentId, thread }]);
      };
      for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
        for (const thread of get(environmentThreadsAtom(environmentId))) {
          const parent = thread.lineage.parentThreadId;
          if (parent !== null && thread.lineage.relationshipToParent === "subagent") {
            addChild({ environmentId, threadId: parent }, environmentId, thread);
          } else if (thread.delegatedFrom !== undefined) {
            addChild(thread.delegatedFrom, environmentId, thread);
          }
        }
      }
      const seen = new Set<string>([key]);
      const pending = [key];
      const next: EnvironmentThreadShell[] = [];
      for (const parent of pending) {
        for (const { environmentId, thread } of children.get(parent) ?? []) {
          const childKey = threadKey({ environmentId, threadId: thread.id });
          if (seen.has(childKey)) continue;
          seen.add(childKey);
          pending.push(childKey);
          if (subagentRequest(thread) !== null) {
            next.push(
              scopedThread(environmentId, thread, get(pendingSubagentRequestsAtom(environmentId))),
            );
          }
        }
      }
      // Indicators read only ids, titles and the request kind, so other shell
      // updates keep the old array.
      if (
        previous.length === next.length &&
        previous.every(
          (thread, index) =>
            thread.environmentId === next[index]?.environmentId &&
            thread.id === next[index]?.id &&
            thread.title === next[index]?.title &&
            thread.hasPendingApprovals === next[index]?.hasPendingApprovals,
        )
      ) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-child-thread-inputs:${key}`));
  });

  const threadShellsForProjectRefsAtomFamily = Atom.family((key: string) => {
    const projectRefs = parseProjectRefCollectionKey(key);
    let previous: ReadonlyArray<EnvironmentThreadShell> = [];
    return Atom.make((get) => {
      const next: EnvironmentThreadShell[] = [];
      const seen = new Set<string>();
      for (const projectRef of projectRefs) {
        const refs =
          get(environmentThreadRefsByProjectAtom(projectRef.environmentId)).get(
            projectRef.projectId,
          ) ?? EMPTY_SCOPED_THREAD_REFS;
        if (refs.length === 0) continue;
        const threads = get(environmentThreadIndexAtom(projectRef.environmentId));
        const subagentRequests = get(pendingSubagentRequestsAtom(projectRef.environmentId));
        for (const ref of refs) {
          const key = threadKey(ref);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const thread = threads.get(ref.threadId);
          if (thread !== undefined) {
            next.push(scopedThread(ref.environmentId, thread, subagentRequests));
          }
        }
      }
      if (arrayElementsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-shells-for-projects:${key}`));
  });

  let previousThreadRefs: ReadonlyArray<ScopedThreadRef> = [];
  const threadRefsAtom = Atom.make((get) => {
    const refs: ScopedThreadRef[] = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      refs.push(...get(environmentThreadRefsAtom(environmentId)));
    }
    if (threadRefsEqual(previousThreadRefs, refs)) {
      return previousThreadRefs;
    }
    previousThreadRefs = refs;
    return refs;
  }).pipe(Atom.withLabel("environment-thread-refs"));

  let previousThreadShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const threadShellsAtom = Atom.make((get) => {
    const next: EnvironmentThreadShell[] = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const subagentRequests = get(pendingSubagentRequestsAtom(environmentId));
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        next.push(scopedThread(environmentId, thread, subagentRequests));
      }
    }
    if (arrayElementsEqual(previousThreadShells, next)) {
      return previousThreadShells;
    }
    previousThreadShells = next;
    return previousThreadShells;
  }).pipe(Atom.withLabel("environment-thread-shell-list"));

  // Lists that arrange threads read this, so a running thread's streaming
  // ticks reach only what reads its live shell.
  let previousQuietThreadShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const quietThreadShellsAtom = Atom.make((get) => {
    const next: EnvironmentThreadShell[] = [];
    for (const ref of get(threadRefsAtom)) {
      const shell = get(quietThreadShellAtomFamily(threadKey(ref)));
      if (shell !== null) next.push(shell);
    }
    if (arrayElementsEqual(previousQuietThreadShells, next)) return previousQuietThreadShells;
    previousQuietThreadShells = next;
    return next;
  }).pipe(Atom.withLabel("environment-quiet-thread-shell-list"));

  let previousDelegatedUnderParent: ReadonlySet<string> = new Set();
  const delegatedUnderParentAtom = Atom.make((get) => {
    const environmentIds = new Set(enabledEnvironmentIds(get(input.catalogValueAtom)));
    const next = new Set<string>();
    for (const environmentId of environmentIds) {
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        const parent = thread.delegatedFrom;
        if (
          parent !== undefined &&
          environmentIds.has(parent.environmentId) &&
          // An archived parent leaves navigation; its task there stays listed on its own.
          get(environmentThreadIndexAtom(parent.environmentId)).get(parent.threadId)?.archivedAt ===
            null
        ) {
          next.add(threadKey({ environmentId, threadId: thread.id }));
        }
      }
    }
    if (
      next.size === previousDelegatedUnderParent.size &&
      [...next].every((key) => previousDelegatedUnderParent.has(key))
    ) {
      return previousDelegatedUnderParent;
    }
    previousDelegatedUnderParent = next;
    return next;
  }).pipe(Atom.withLabel("environment-delegated-under-parent"));

  let previousNavigationShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const navigationThreadShellsAtom = Atom.make((get) => {
    const next: EnvironmentThreadShell[] = [];
    const underParent = get(delegatedUnderParentAtom);
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const subagentRequests = get(pendingSubagentRequestsAtom(environmentId));
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        if (
          thread.archivedAt !== null ||
          isShownUnderParent({ environmentId, threadId: thread.id }, thread.lineage, underParent)
        ) {
          continue;
        }
        next.push(scopedThread(environmentId, thread, subagentRequests));
      }
    }
    if (arrayElementsEqual(previousNavigationShells, next)) return previousNavigationShells;
    previousNavigationShells = next;
    return next;
  }).pipe(Atom.withLabel("environment-navigation-thread-shells"));

  return {
    environmentThreadsAtom,
    environmentThreadIndexAtom,
    environmentThreadRefsAtom,
    environmentThreadRefsByProjectAtom,
    threadRefsAtom,
    threadShellsAtom,
    quietThreadShellsAtom,
    navigationThreadShellsAtom,
    delegatedUnderParentAtom,
    pendingSubagentRequestsAtom,
    threadShellsForProjectRefsAtom: (refs: ReadonlyArray<ScopedProjectRef>) =>
      threadShellsForProjectRefsAtomFamily(projectRefCollectionKey(refs)),
    threadShellAtom: (ref: ScopedThreadRef) => threadShellAtomFamily(threadKey(ref)),
    quietThreadShellAtom: (ref: ScopedThreadRef) => quietThreadShellAtomFamily(threadKey(ref)),
    childThreadInputsAtom: (ref: ScopedThreadRef) => childThreadInputsAtomFamily(threadKey(ref)),
  };
}
