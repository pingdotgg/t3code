import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef, ScopedThreadRef, ServerConfig } from "@t3tools/contracts";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom } from "./server";
import {
  allEnvironmentProjectSnapshotsReadyAtom,
  allEnvironmentShellsBootstrappedAtom,
} from "./shell";
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
const EMPTY_THREAD_REFS_ATOM = Atom.make(EMPTY_THREAD_REFS).pipe(
  Atom.withLabel("web-thread-refs:empty"),
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
  return useAtomValue(environmentThreadShells.threadRefsAtom);
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
  return useAtomValue(
    environmentId === null
      ? EMPTY_THREAD_REFS_ATOM
      : environmentThreadShells.environmentThreadRefsAtom(environmentId),
  );
}

export function useProjects(): ReadonlyArray<EnvironmentProject> {
  return useAtomValue(environmentProjects.projectsAtom);
}

export function useServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return useAtomValue(environmentServerConfigsAtom);
}

export function useThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.threadShellsAtom);
}

export function useAllEnvironmentShellsBootstrapped(): boolean {
  return useAtomValue(allEnvironmentShellsBootstrappedAtom);
}

export function useAllEnvironmentProjectSnapshotsReady(): boolean {
  return useAtomValue(allEnvironmentProjectSnapshotsReadyAtom);
}

export function useThreadShellsForProjectRefs(
  refs: ReadonlyArray<ScopedProjectRef>,
): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.threadShellsForProjectRefsAtom(refs));
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

export function readProjects(): ReadonlyArray<EnvironmentProject> {
  return appAtomRegistry.get(environmentProjects.projectsAtom);
}

/** Resolves when the project event reaches the live client store. */
export function waitForProject(
  ref: ScopedProjectRef,
  timeoutMs = 10_000,
): Promise<EnvironmentProject> {
  const current = readProject(ref);
  if (current !== null) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("The project did not appear in the desktop app."));
    }, timeoutMs);
    const finish = (project: EnvironmentProject | null) => {
      if (project === null) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(project);
    };
    unsubscribe = appAtomRegistry.subscribe(environmentProjects.projectAtom(ref), finish);
    finish(readProject(ref));
  });
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

/** Whether the environment's server understands thread.pin/unpin.
    Same version-skew contract as settlement. */
export function readEnvironmentSupportsPinning(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinning === true
  );
}

/** Whether the environment's server understands thread title regeneration.
    Same version-skew contract as settlement. */
export function readEnvironmentSupportsTitleRegeneration(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadTitleRegeneration === true
  );
}

<<<<<<< HEAD
/** Whether the environment's server understands thread.pin.reorder (and
    orderKey on thread.pin). Same version-skew contract as settlement. */
export function readEnvironmentSupportsPinReorder(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinReorder === true
  );
}

export function readThreadDetail(ref: ScopedThreadRef): EnvironmentThread | null {
  return appAtomRegistry.get(environmentThreadDetails.detailAtom(ref));
=======
export function readThreadProjection(ref: ScopedThreadRef): EnvironmentThread | null {
  return appAtomRegistry.get(environmentThreadDetails.threadAtom(ref));
>>>>>>> d849d1caf9 (Retire V1 client orchestration parity)
}

export function readEnvironmentThreadRefs(
  environmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  return appAtomRegistry.get(environmentThreadShells.environmentThreadRefsAtom(environmentId));
}

export function readThreadRefs(): ReadonlyArray<ScopedThreadRef> {
  return appAtomRegistry.get(environmentThreadShells.threadRefsAtom);
}

export function readThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
}

export function findThreadRef(threadId: ThreadId): ScopedThreadRef | null {
  return (
    appAtomRegistry
      .get(environmentThreadShells.threadRefsAtom)
      .find((ref) => ref.threadId === threadId) ?? null
  );
}
