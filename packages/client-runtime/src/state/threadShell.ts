import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadForkOrigin,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentThreadShell } from "./models.ts";
import { scopeThreadShell } from "./models.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import {
  arrayElementsEqual,
  parseProjectRefCollectionKey,
  parseThreadKey,
  projectRefCollectionKey,
  threadKey,
  threadRefsEqual,
} from "./entities.ts";

const EMPTY_THREADS: ReadonlyArray<OrchestrationThreadShell> = Object.freeze([]);
const EMPTY_ENVIRONMENT_THREADS: ReadonlyArray<EnvironmentThreadShell> = Object.freeze([]);
const EMPTY_SCOPED_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);
const EMPTY_THREAD_INDEX: ReadonlyMap<ThreadId, OrchestrationThreadShell> = new Map();
const EMPTY_THREAD_REFS_BY_PROJECT: ReadonlyMap<
  ProjectId,
  ReadonlyArray<ScopedThreadRef>
> = new Map();
const EMPTY_SIDE_CHATS_BY_PARENT: ReadonlyMap<
  ThreadId,
  ReadonlyArray<EnvironmentThreadShell>
> = new Map();

export function isSideChat(shell: OrchestrationThreadShell): boolean {
  return shell.sideChat === true;
}

export function forkOrigin(shell: OrchestrationThreadShell): ThreadForkOrigin | null {
  return shell.fork ?? null;
}

function isHiddenSideChat(
  shell: OrchestrationThreadShell,
  threadIds: Pick<ReadonlyMap<ThreadId, unknown>, "has">,
): boolean {
  const origin = forkOrigin(shell);
  return isSideChat(shell) && origin !== null && threadIds.has(origin.sourceThreadId);
}

export function createEnvironmentThreadShellAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  // Point reads and aggregate lists share values without keeping an atom alive
  // for every listed thread. Replaced source objects can be collected.
  const scopedThreads = new WeakMap<
    OrchestrationThreadShell,
    Map<EnvironmentId, EnvironmentThreadShell>
  >();
  const scopedThread = (environmentId: EnvironmentId, thread: OrchestrationThreadShell) => {
    let byEnvironment = scopedThreads.get(thread);
    if (byEnvironment === undefined) {
      byEnvironment = new Map();
      scopedThreads.set(thread, byEnvironment);
    }
    let value = byEnvironment.get(environmentId);
    if (value === undefined) {
      value = scopeThreadShell(environmentId, thread);
      byEnvironment.set(environmentId, value);
    }
    return value;
  };

  const environmentThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationThreadShell> =>
        get(input.snapshotAtom(environmentId))?.threads ?? EMPTY_THREADS,
    ).pipe(Atom.withLabel(`environment-threads:${environmentId}`)),
  );

  const environmentThreadIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<ThreadId, OrchestrationThreadShell> => {
      const threads = get(environmentThreadsAtom(environmentId));
      if (threads.length === 0) {
        return EMPTY_THREAD_INDEX;
      }
      return new Map(threads.map((thread) => [thread.id, thread] as const));
    }).pipe(Atom.withLabel(`environment-thread-index:${environmentId}`)),
  );

  // Every thread the environment owns, side chats included. Ownership checks
  // (worktree cleanup, membership, outbox routing) must read this list. A side
  // chat shares its parent's worktree, so omitting it would make that worktree
  // look orphaned when the parent is deleted.
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

  // What thread lists show: side chats stay hidden while their parent exists
  // and are grouped beside it instead.
  const environmentVisibleThreadRefsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ScopedThreadRef> = [];
    return Atom.make((get) => {
      const threadIds = get(environmentThreadIndexAtom(environmentId));
      const next = get(environmentThreadsAtom(environmentId))
        .filter((thread) => !isHiddenSideChat(thread, threadIds))
        .map((thread) => ({
          environmentId,
          threadId: thread.id,
        }));
      if (threadRefsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-visible-thread-refs:${environmentId}`));
  });

  const environmentThreadRefsByProjectAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyMap<
      ProjectId,
      ReadonlyArray<ScopedThreadRef>
    > = EMPTY_THREAD_REFS_BY_PROJECT;
    return Atom.make((get) => {
      const grouped = new Map<ProjectId, ScopedThreadRef[]>();
      const threadIds = get(environmentThreadIndexAtom(environmentId));
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        if (isHiddenSideChat(thread, threadIds)) continue;
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

  const environmentSideChatsByParentAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyMap<
      ThreadId,
      ReadonlyArray<EnvironmentThreadShell>
    > = EMPTY_SIDE_CHATS_BY_PARENT;
    let previousSources: ReadonlyMap<ThreadId, ReadonlyArray<OrchestrationThreadShell>> = new Map();
    return Atom.make((get): ReadonlyMap<ThreadId, ReadonlyArray<EnvironmentThreadShell>> => {
      const grouped = new Map<ThreadId, OrchestrationThreadShell[]>();
      const threadIds = get(environmentThreadIndexAtom(environmentId));
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        if (!isHiddenSideChat(thread, threadIds)) continue;
        const origin = forkOrigin(thread);
        if (origin === null) continue;
        const siblings = grouped.get(origin.sourceThreadId);
        if (siblings === undefined) {
          grouped.set(origin.sourceThreadId, [thread]);
        } else {
          siblings.push(thread);
        }
      }
      if (grouped.size === 0) {
        previous = EMPTY_SIDE_CHATS_BY_PARENT;
        previousSources = new Map();
        return previous;
      }
      let unchanged = grouped.size === previous.size;
      const next = new Map<ThreadId, ReadonlyArray<EnvironmentThreadShell>>();
      for (const [parentId, threads] of grouped) {
        const previousThreads = previousSources.get(parentId);
        const previousScoped = previous.get(parentId);
        const scoped =
          previousThreads !== undefined &&
          previousScoped !== undefined &&
          arrayElementsEqual(previousThreads, threads)
            ? previousScoped
            : threads.map((thread) => scopeThreadShell(environmentId, thread));
        next.set(parentId, scoped);
        unchanged &&= scoped === previousScoped;
      }
      previousSources = grouped;
      if (unchanged) {
        return previous;
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-side-chats-by-parent:${environmentId}`));
  });

  const sideChatsByParentAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make(
      (get): ReadonlyArray<EnvironmentThreadShell> =>
        get(environmentSideChatsByParentAtom(ref.environmentId)).get(ref.threadId) ??
        EMPTY_ENVIRONMENT_THREADS,
    ).pipe(Atom.withLabel(`side-chats-by-parent:${key}`));
  });

  const threadShellAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) => {
      const source = get(environmentThreadIndexAtom(ref.environmentId)).get(ref.threadId) ?? null;
      return source === null ? null : scopedThread(ref.environmentId, source);
    }).pipe(Atom.withLabel(`environment-thread-shell:${key}`));
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
        for (const ref of refs) {
          const key = threadKey(ref);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const thread = threads.get(ref.threadId);
          if (thread !== undefined) {
            next.push(scopedThread(ref.environmentId, thread));
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
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
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
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        next.push(scopedThread(environmentId, thread));
      }
    }
    if (arrayElementsEqual(previousThreadShells, next)) {
      return previousThreadShells;
    }
    previousThreadShells = next;
    return previousThreadShells;
  }).pipe(Atom.withLabel("environment-thread-shell-list"));

  // The list a thread picker or sidebar renders: `threadShellsAtom` minus side
  // chats whose parent is still present.
  let previousVisibleThreadShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const visibleThreadShellsAtom = Atom.make((get) => {
    const next: EnvironmentThreadShell[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const threadIds = get(environmentThreadIndexAtom(environmentId));
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        if (isHiddenSideChat(thread, threadIds)) continue;
        next.push(scopedThread(environmentId, thread));
      }
    }
    if (arrayElementsEqual(previousVisibleThreadShells, next)) {
      return previousVisibleThreadShells;
    }
    previousVisibleThreadShells = next;
    return previousVisibleThreadShells;
  }).pipe(Atom.withLabel("environment-visible-thread-shell-list"));

  return {
    environmentThreadsAtom,
    environmentThreadIndexAtom,
    environmentThreadRefsAtom,
    environmentVisibleThreadRefsAtom,
    environmentThreadRefsByProjectAtom,
    environmentSideChatsByParentAtom,
    threadRefsAtom,
    threadShellsAtom,
    visibleThreadShellsAtom,
    sideChatsByParentAtom: (ref: ScopedThreadRef) => sideChatsByParentAtomFamily(threadKey(ref)),
    threadShellsForProjectRefsAtom: (refs: ReadonlyArray<ScopedProjectRef>) =>
      threadShellsForProjectRefsAtomFamily(projectRefCollectionKey(refs)),
    threadShellAtom: (ref: ScopedThreadRef) => threadShellAtomFamily(threadKey(ref)),
  };
}
