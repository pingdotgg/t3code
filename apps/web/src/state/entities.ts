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
  OrchestrationV2RemoteTaskChild,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  NodeId,
  ThreadId,
  TurnItemId,
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
const EMPTY_ASSISTANT_MESSAGE_TEXT_ATOM = Atom.make<string | null>(null).pipe(
  Atom.withLabel("web-assistant-message-text:empty"),
);
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

/** Whether any connected environment is hiding tagged threads right now. */
export function useAnyEnvironmentHiding(): boolean {
  return useAtomValue(environmentThreadShells.anyEnvironmentHidingAtom);
}

/** Keys of threads the tag filter hides from display, by `threadKey`. */
export function useHiddenThreadKeys(): ReadonlySet<string> {
  return useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
}

/** Thread shells minus those the tag filter hides, for lists that show threads to the user. */
export function useVisibleThreadShells(enabled = true): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(
    enabled ? environmentThreadShells.visibleThreadShellsAtom : EMPTY_THREAD_SHELLS_ATOM,
  );
}

export function useAllEnvironmentShellsBootstrapped(): boolean {
  return useAtomValue(allEnvironmentShellsBootstrappedAtom);
}

export function useAllEnvironmentProjectSnapshotsReady(): boolean {
  return useAtomValue(allEnvironmentProjectSnapshotsReadyAtom);
}

/** Tasks linked environments run for a listed thread, by thread key; lists show them under it. */
export function useDelegatedUnderParent(): ReadonlySet<string> {
  return useAtomValue(environmentThreadShells.delegatedUnderParentAtom);
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

/** Visible turn items held through streamed assistant text; see useAssistantMessageText. */
export function useTimelineVisibleTurnItems(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  return useAtomValue(
    ref === null
      ? EMPTY_VISIBLE_TURN_ITEMS_ATOM
      : environmentThreadDetails.timelineVisibleTurnItemsAtom(ref),
  );
}

/** One assistant message's live text, or null when the thread does not hold the item. */
export function useAssistantMessageText(
  ref: ScopedThreadRef | null,
  itemId: string | undefined,
): string | null {
  return useAtomValue(
    ref === null || itemId === undefined
      ? EMPTY_ASSISTANT_MESSAGE_TEXT_ATOM
      : environmentThreadDetails.assistantMessageTextAtom(ref, itemId),
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

/** The thread's loaded timeline, for a handler that reads it once instead of subscribing. */
export function readThreadTurnItems(ref: ScopedThreadRef) {
  return (
    appAtomRegistry.get(environmentThreadDetails.quietThreadAtom(ref))?.projection
      .visibleTurnItems ?? []
  );
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

export function readEnvironmentServerConfigLoaded(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(environmentServerConfigsAtom).has(environmentId);
}

export function readEnvironmentSupportsAutoSettleOptOut(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadAutoSettleOptOut === true
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

interface SubagentChild {
  readonly threadId: ThreadId;
  /** Set when the task ran on a linked environment, which holds its thread. */
  readonly environmentId?: EnvironmentId;
  readonly title: string | null | undefined;
}

/**
 * The subagents a response reported on, read once on demand so a timeline row does not subscribe
 * to the thread for it. A result reaches the thread as a message from the subagent's thread or as
 * a completion notice, at the start of a run or steered into one, so the inputs just before the
 * response decide it. Turn items are read because older history loads nothing else.
 */
export function readResponseSubagents(
  ref: ScopedThreadRef,
  itemId: TurnItemId,
): ReadonlyArray<Omit<SubagentChild, "title"> & { readonly title: string }> {
  const projection = appAtomRegistry.get(environmentThreadDetails.quietThreadAtom(ref))?.projection;
  if (!projection) return [];
  const items = projection.visibleTurnItems;
  const isInput = (index: number) => {
    const type = items[index]?.item.type;
    return type === "user_message" || type === "notification";
  };
  let index = items.findIndex((projected) => projected.sourceItemId === itemId) - 1;
  while (index >= 0 && !isInput(index)) index -= 1;

  const byTask = new Map<NodeId, SubagentChild>();
  const local = new Map<ThreadId, SubagentChild>();
  const remember = (
    taskId: NodeId,
    childThreadId: ThreadId | null,
    remote: OrchestrationV2RemoteTaskChild | undefined,
    title: string | null,
  ) => {
    if (childThreadId !== null) {
      const child = { threadId: childThreadId, title };
      byTask.set(taskId, child);
      local.set(childThreadId, child);
    } else if (remote) {
      // A task sent to a linked environment has no thread here; its thread lives there.
      const { threadId, environmentId } = remote;
      byTask.set(taskId, { threadId, environmentId, title: title ?? remote.title });
    }
  };
  for (const { item } of items) {
    if (item.type === "subagent") {
      remember(item.subagentId, item.childThreadId, item.remoteChild, null);
    }
  }
  for (const subagent of projection.subagents) {
    remember(subagent.id, subagent.childThreadId, subagent.remoteChild, subagent.title);
  }

  const found = new Map<string, SubagentChild>();
  const add = (child: SubagentChild | undefined) => {
    if (child) found.set(`${child.environmentId ?? ""}:${child.threadId}`, child);
  };
  for (; index >= 0 && isInput(index); index -= 1) {
    const item = items[index]!.item;
    if (item.type === "notification") {
      // A notice names its child itself, so it counts even when the task is no longer loaded.
      if ("childThreadId" in item.source && item.source.childThreadId !== undefined) {
        const threadId = item.source.childThreadId;
        add(local.get(threadId) ?? { threadId, title: null });
      }
      for (const taskId of "taskIds" in item.source ? item.source.taskIds : []) {
        add(byTask.get(taskId));
      }
    } else if (item.type === "user_message") {
      const message = projection.messages.find(({ id }) => id === item.messageId);
      for (const taskId of message?.delegatedCompletion?.taskIds ?? []) add(byTask.get(taskId));
      // A sender counts only as this thread's subagent: a child's first message comes from its parent.
      if (item.senderThreadId !== undefined) add(local.get(item.senderThreadId));
    }
  }
  return [...found.values()].map(({ title, ...child }) => ({
    ...child,
    title:
      title?.trim() ||
      appAtomRegistry
        .get(
          environmentThreadShells.quietThreadShellAtom({
            environmentId: child.environmentId ?? ref.environmentId,
            threadId: child.threadId,
          }),
        )
        ?.title.trim() ||
      "Agent",
  }));
}
