import type * as DateTime from "effect/DateTime";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
  EnvironmentThreadStructure,
  ThreadStructureVisibleTurnItem,
} from "@t3tools/client-runtime/state/shell";
import {
  EMPTY_THREAD_HISTORY_META,
  type EnvironmentThreadStatus,
  type ThreadHistoryMeta,
} from "@t3tools/client-runtime/state/threads";
import {
  arrayElementsEqual,
  parseThreadKey,
  threadKey,
} from "@t3tools/client-runtime/state/entities";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "./projects";
import { environmentPresentations } from "./presentation";
import { environmentServerConfigsAtom } from "./server";
import {
  allEnvironmentProjectSnapshotsReadyAtom,
  allEnvironmentShellsBootstrappedAtom,
} from "./shell";
import { environmentThreadDetails, environmentThreadShells } from "./threads";
import { waitForAtomValue } from "./waitForAtomValue";

const EMPTY_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);
const EMPTY_VISIBLE_TURN_ITEMS: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = Object.freeze([]);

const EMPTY_PROJECT_ATOM = Atom.make<EnvironmentProject | null>(null).pipe(
  Atom.withLabel("web-project:empty"),
);
const EMPTY_THREAD_REFS_ATOM = Atom.make(EMPTY_THREAD_REFS).pipe(
  Atom.withLabel("web-thread-refs:empty"),
);
const EMPTY_THREAD_SHELLS_ATOM = Atom.make<ReadonlyArray<EnvironmentThreadShell>>(
  Object.freeze([]),
).pipe(Atom.withLabel("web-thread-shells:empty"));
const EMPTY_THREAD_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("web-thread-shell:empty"),
);
const EMPTY_THREAD_PROJECTION_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("web-thread-projection:empty"),
);
const EMPTY_THREAD_STATUS_ATOM = Atom.make<EnvironmentThreadStatus>("empty").pipe(
  Atom.withLabel("web-thread-status:empty"),
);
const EMPTY_VISIBLE_TURN_ITEMS_ATOM = Atom.make(EMPTY_VISIBLE_TURN_ITEMS).pipe(
  Atom.withLabel("web-thread-visible-turn-items:empty"),
);
const EMPTY_CHECKPOINT_SUMMARIES_ATOM = Atom.make<ReadonlyArray<ThreadCheckpointSummary>>(
  Object.freeze([]),
).pipe(Atom.withLabel("web-thread-checkpoint-summaries:empty"));
const EMPTY_LAST_VISITED_AT_ATOM = Atom.make<DateTime.Utc | null>(null).pipe(
  Atom.withLabel("web-thread-last-visited:empty"),
);
const EMPTY_UPDATED_AT_ATOM = Atom.make<DateTime.Utc | null>(null).pipe(
  Atom.withLabel("web-thread-updated-at:empty"),
);
const EMPTY_THREAD_HISTORY_ATOM = Atom.make<ThreadHistoryMeta>(EMPTY_THREAD_HISTORY_META).pipe(
  Atom.withLabel("web-thread-history:empty"),
);

export function useThreadRefs(enabled = true): ReadonlyArray<ScopedThreadRef> {
  return useAtomValue(enabled ? environmentThreadShells.threadRefsAtom : EMPTY_THREAD_REFS_ATOM);
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

/** Providers are left out; read them with `useEnvironmentProviders()`. */
export function useServerConfigs() {
  return useAtomValue(environmentPresentations.serverConfigsAtom);
}

export function useThreadShells(enabled = true): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(
    enabled ? environmentThreadShells.threadShellsAtom : EMPTY_THREAD_SHELLS_ATOM,
  );
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

/** The shell without its streaming timestamps; see quietThreadShellAtom. */
export function useQuietThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.quietThreadShellAtom(ref),
  );
}

/** Every thread shell, held through streaming ticks; see quietThreadShellAtom. */
export function useQuietThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.quietThreadShellsAtom);
}

export function useChildThreadInputs(ref: ScopedThreadRef | null) {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELLS_ATOM : environmentThreadShells.childThreadInputsAtom(ref),
  );
}

export function useThreadProjection(ref: ScopedThreadRef | null): EnvironmentThread | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_PROJECTION_ATOM : environmentThreadDetails.threadAtom(ref),
  );
}

/** The thread's structure, held through streamed assistant and reasoning text; see ThreadStructure. */
export function useQuietThreadProjection(
  ref: ScopedThreadRef | null,
): EnvironmentThreadStructure | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_PROJECTION_ATOM : environmentThreadDetails.quietThreadAtom(ref),
  );
}

/** The detail's live visit mark, which the thread structure leaves out. */
export function useThreadLastVisitedAt(ref: ScopedThreadRef | null): DateTime.Utc | null {
  return useAtomValue(
    ref === null ? EMPTY_LAST_VISITED_AT_ATOM : environmentThreadDetails.lastVisitedAtAtom(ref),
  );
}

/** The detail's live `updatedAt`, which the thread structure leaves out. */
export function useThreadUpdatedAt(ref: ScopedThreadRef | null): DateTime.Utc | null {
  return useAtomValue(
    ref === null ? EMPTY_UPDATED_AT_ATOM : environmentThreadDetails.updatedAtAtom(ref),
  );
}

export function useThreadStatus(ref: ScopedThreadRef | null): EnvironmentThreadStatus {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_STATUS_ATOM : environmentThreadDetails.statusAtom(ref),
  );
}

export function useThreadHistory(ref: ScopedThreadRef | null): ThreadHistoryMeta {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_HISTORY_ATOM : environmentThreadDetails.historyAtom(ref),
  );
}

export function resolveThreadDetailRef(
  ref: ScopedThreadRef | null,
  options: {
    shellExists: boolean;
    waitForShell: boolean;
  },
): ScopedThreadRef | null {
  return ref !== null && (!options.waitForShell || options.shellExists) ? ref : null;
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

/** Visible turn items without their streamed text; see ThreadStructure. */
export function useQuietThreadVisibleTurnItems(
  ref: ScopedThreadRef | null,
): ReadonlyArray<ThreadStructureVisibleTurnItem> {
  return useAtomValue(
    ref === null
      ? EMPTY_VISIBLE_TURN_ITEMS_ATOM
      : environmentThreadDetails.quietVisibleTurnItemsAtom(ref),
  );
}

export function useThreadCheckpointSummaries(
  ref: ScopedThreadRef | null,
): ReadonlyArray<ThreadCheckpointSummary> {
  return useAtomValue(
    ref === null
      ? EMPTY_CHECKPOINT_SUMMARIES_ATOM
      : environmentThreadDetails.checkpointSummariesAtom(ref),
  );
}

export function readProject(ref: ScopedProjectRef): EnvironmentProject | null {
  return appAtomRegistry.get(environmentProjects.projectAtom(ref));
}

export function subscribeProject(
  ref: ScopedProjectRef,
  listener: (project: EnvironmentProject | null) => void,
): () => void {
  return appAtomRegistry.subscribe(environmentProjects.projectAtom(ref), listener);
}

export function readProjects(): ReadonlyArray<EnvironmentProject> {
  return appAtomRegistry.get(environmentProjects.projectsAtom);
}

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

/** Waits for removal from the live store; delete replies arrive before the shell stream. */
export function waitForProjectRemoval(ref: ScopedProjectRef, timeoutMs = 5_000): Promise<boolean> {
  return waitForAtomValue({
    registry: appAtomRegistry,
    atom: environmentProjects.projectAtom(ref),
    predicate: (project) => project === null,
    timeoutMs,
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

export function useEnvironmentSupportsServerBrowser(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.serverBrowser === true
  );
}

export function readEnvironmentSupportsServerBrowser(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .serverBrowser === true
  );
}

export function readEnvironmentSupportsTitleRegeneration(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadTitleRegeneration === true
  );
}

export function readEnvironmentSupportsPinning(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinning === true
  );
}

export function readEnvironmentSupportsPinReorder(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinReorder === true
  );
}

export function readEnvironmentSupportsAutoSettleOptOut(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadAutoSettleOptOut === true
  );
}

export function readEnvironmentSupportsActiveReorder(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadActiveReorder === true
  );
}

export function readEnvironmentSupportsSettlement(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

export function readEnvironmentSupportsSnooze(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSnooze === true
  );
}

export function readEnvironmentSupportsVisitedTracking(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadVisitedTracking === true
  );
}

export function readEnvironmentThreadRefs(
  environmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  return appAtomRegistry.get(environmentThreadShells.environmentThreadRefsAtom(environmentId));
}

export function readThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
}

function shellParentThreadId(
  thread: Pick<OrchestrationV2ThreadShell, "forkedFrom" | "lineage">,
): ThreadId | null {
  return thread.forkedFrom?.type === "run"
    ? thread.forkedFrom.threadId
    : thread.lineage.parentThreadId;
}

/** Retains unchanged reachable shells so unrelated streams do not re-render the panel. */
export function selectThreadRelationshipShells(
  threadId: ThreadId,
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "subagents" | "contextTransfers"
  > | null,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const named = new Set<string>([threadId]);
  if (projection !== null) {
    const parentThreadId = shellParentThreadId(projection.thread);
    if (parentThreadId !== null) named.add(parentThreadId);
    for (const subagent of projection.subagents) {
      if (subagent.childThreadId !== null) named.add(subagent.childThreadId);
      for (const agent of subagent.workflow?.agents ?? []) {
        if (agent.childThreadId !== undefined) named.add(agent.childThreadId);
      }
    }
    for (const transfer of projection.contextTransfers) {
      named.add(transfer.sourceThreadId);
      named.add(transfer.targetThreadId);
    }
  }
  const current = threads.find((thread) => thread.id === threadId);
  const currentParentId = current === undefined ? null : shellParentThreadId(current);
  if (currentParentId !== null) named.add(currentParentId);
  return threads.filter(
    (thread) => named.has(thread.id) || shellParentThreadId(thread) === threadId,
  );
}

const relationshipShellsAtomFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  let previous: ReadonlyArray<OrchestrationV2ThreadShell> = [];
  return Atom.make((get) => {
    const next = selectThreadRelationshipShells(
      ref.threadId,
      get(environmentThreadDetails.threadAtom(ref))?.projection ?? null,
      get(environmentThreadShells.environmentThreadsAtom(ref.environmentId)),
    );
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-thread-relationship-shells:${key}`));
});

export function useThreadRelationshipShells(
  ref: ScopedThreadRef,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  return useAtomValue(relationshipShellsAtomFamily(threadKey(ref)));
}
