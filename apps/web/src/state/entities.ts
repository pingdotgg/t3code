import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ScopedThreadRef, ServerConfig } from "@t3tools/contracts";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { isUserFacingThread } from "../threadVisibility";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom } from "./server";
import { allEnvironmentShellsBootstrappedAtom } from "./shell";
import { environmentThreadDetails, environmentThreadShells } from "./threads";
import { waitForAtomValue } from "./waitForAtomValue";

const EMPTY_PROJECT_REFS: ReadonlyArray<ScopedProjectRef> = Object.freeze([]);
const EMPTY_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);
const EMPTY_VISIBLE_TURN_ITEMS: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = Object.freeze([]);

const EMPTY_PROJECT_ATOM = Atom.make<EnvironmentProject | null>(null).pipe(
  Atom.withLabel("web-project:empty"),
);
const EMPTY_PROJECT_REFS_ATOM = Atom.make(EMPTY_PROJECT_REFS).pipe(
  Atom.withLabel("web-project-refs:empty"),
);
const EMPTY_THREAD_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("web-thread-shell:empty"),
);
const EMPTY_THREAD_PROJECTION_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("web-thread-projection:empty"),
);
const EMPTY_VISIBLE_TURN_ITEMS_ATOM = Atom.make(EMPTY_VISIBLE_TURN_ITEMS).pipe(
  Atom.withLabel("web-thread-visible-turn-items:empty"),
);

export const activeEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-active-environment-id"),
);

export function useActiveEnvironmentId(): EnvironmentId | null {
  return useAtomValue(activeEnvironmentIdAtom);
}

export function readActiveEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(activeEnvironmentIdAtom);
}

export function setActiveEnvironmentId(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(activeEnvironmentIdAtom, environmentId);
}

export function useProjectRefs(): ReadonlyArray<ScopedProjectRef> {
  return useAtomValue(environmentProjects.projectRefsAtom);
}

export function useThreadRefs(): ReadonlyArray<ScopedThreadRef> {
  const threads = useThreadShells();
  return useMemo(
    () => threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
    [threads],
  );
}

export function useEnvironmentProjectRefs(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ScopedProjectRef> {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PROJECT_REFS_ATOM
      : environmentProjects.environmentProjectRefsAtom(environmentId),
  );
}

export function useEnvironmentThreadRefs(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ScopedThreadRef> {
  const threads = useThreadShells();
  return useMemo(
    () =>
      environmentId === null
        ? EMPTY_THREAD_REFS
        : threads.flatMap((thread) =>
            thread.environmentId === environmentId
              ? [scopeThreadRef(thread.environmentId, thread.id)]
              : [],
          ),
    [environmentId, threads],
  );
}

export function useProjects(): ReadonlyArray<EnvironmentProject> {
  return useAtomValue(environmentProjects.projectsAtom);
}

export function useServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return useAtomValue(environmentServerConfigsAtom);
}

export function useThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  const threads = useAtomValue(environmentThreadShells.threadShellsAtom);
  return useMemo(() => threads.filter(isUserFacingThread), [threads]);
}

export function useAllEnvironmentShellsBootstrapped(): boolean {
  return useAtomValue(allEnvironmentShellsBootstrappedAtom);
}

export function useThreadShellsForProjectRefs(
  refs: ReadonlyArray<ScopedProjectRef>,
): ReadonlyArray<EnvironmentThreadShell> {
  const threads = useAtomValue(environmentThreadShells.threadShellsForProjectRefsAtom(refs));
  return useMemo(() => threads.filter(isUserFacingThread), [threads]);
}

export function useProject(ref: ScopedProjectRef | null): EnvironmentProject | null {
  return useAtomValue(ref === null ? EMPTY_PROJECT_ATOM : environmentProjects.projectAtom(ref));
}

export function useThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.threadShellAtom(ref),
  );
}

export function useThreadProjection(ref: ScopedThreadRef | null): EnvironmentThread | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_PROJECTION_ATOM : environmentThreadDetails.threadAtom(ref),
  );
}

export function useThreadVisibleTurnItems(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  return useAtomValue(
    ref === null
      ? EMPTY_VISIBLE_TURN_ITEMS_ATOM
      : environmentThreadDetails.visibleTurnItemsAtom(ref),
  );
}

export function readProject(ref: ScopedProjectRef): EnvironmentProject | null {
  return appAtomRegistry.get(environmentProjects.projectAtom(ref));
}

export function readThreadShell(ref: ScopedThreadRef): EnvironmentThreadShell | null {
  return appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
}

export function waitForThreadShell(ref: ScopedThreadRef, timeoutMs = 5_000): Promise<boolean> {
  return waitForAtomValue({
    registry: appAtomRegistry,
    atom: environmentThreadShells.threadShellAtom(ref),
    predicate: (thread) => thread !== null,
    timeoutMs,
  });
}

export function readThreadProjection(ref: ScopedThreadRef): EnvironmentThread | null {
  return appAtomRegistry.get(environmentThreadDetails.threadAtom(ref));
}

/** Whether the environment's server understands thread.settle/unsettle.
    False for pre-settlement servers (capability defaults false on decode),
    so clients under version skew fall back instead of erroring. */
export function readEnvironmentSupportsSettlement(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

/** Whether the environment's server understands thread.snooze/unsnooze.
    Same version-skew contract as settlement. */
export function readEnvironmentSupportsSnooze(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSnooze === true
  );
}

export function readEnvironmentThreadRefs(
  environmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  return appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .filter((thread) => thread.environmentId === environmentId && isUserFacingThread(thread))
    .map((thread) => scopeThreadRef(thread.environmentId, thread.id));
}

export function readThreadRefs(): ReadonlyArray<ScopedThreadRef> {
  return appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .filter(isUserFacingThread)
    .map((thread) => scopeThreadRef(thread.environmentId, thread.id));
}

export function findThreadRef(threadId: ThreadId): ScopedThreadRef | null {
  return readThreadRefs().find((ref) => ref.threadId === threadId) ?? null;
}
