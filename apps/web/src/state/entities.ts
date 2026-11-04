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
import {
  MessageId,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2SideChatAnchor,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { isLineageThread } from "@t3tools/client-runtime/state/thread-relationships";
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
    (thread) =>
      (named.has(thread.id) || shellParentThreadId(thread) === threadId) &&
      isLineageThread(thread, threadId),
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

/**
 * The lesson and its live side chats from its environment, in input order. The
 * lesson comes along so the side-chat tree can label its root; archived and
 * deleted shells, other lessons' side chats and other environments are left out.
 */
export function selectSideChatTreeShells(
  lessonRef: ScopedThreadRef,
  shells: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  return shells.filter(
    (shell) =>
      shell.environmentId === lessonRef.environmentId &&
      shell.archivedAt === null &&
      shell.deletedAt === null &&
      (shell.id === lessonRef.threadId || shell.sideChat?.lessonThreadId === lessonRef.threadId),
  );
}

/**
 * Built from the quiet shells and held while the lesson's own shells are
 * unchanged, so another thread streaming does not re-render its readers.
 */
const sideChatTreeShellsAtomFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  let previous: ReadonlyArray<EnvironmentThreadShell> = [];
  return Atom.make((get) => {
    const next = selectSideChatTreeShells(ref, get(environmentThreadShells.quietThreadShellsAtom));
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-side-chat-tree-shells:${key}`));
});

export function useSideChatTreeShells(
  lessonRef: ScopedThreadRef | null,
): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(
    lessonRef === null
      ? EMPTY_THREAD_SHELLS_ATOM
      : sideChatTreeShellsAtomFamily(threadKey(lessonRef)),
  );
}

export function readSideChatTreeShells(
  lessonRef: ScopedThreadRef,
): ReadonlyArray<EnvironmentThreadShell> {
  return appAtomRegistry.get(sideChatTreeShellsAtomFamily(threadKey(lessonRef)));
}

export interface SideChatMark {
  readonly threadId: ThreadId;
  readonly label: string;
  readonly state: "open" | "done";
  readonly anchor: OrchestrationV2SideChatAnchor;
}

const EMPTY_SIDE_CHAT_MARKS: ReadonlyArray<SideChatMark> = Object.freeze([]);
const EMPTY_SIDE_CHAT_MARKS_ATOM = Atom.make(EMPTY_SIDE_CHAT_MARKS).pipe(
  Atom.withLabel("web-side-chat-marks:empty"),
);

function isLiveSideChatAnchoredIn(
  shell: EnvironmentThreadShell,
  anchorRef: ScopedThreadRef,
): boolean {
  return (
    shell.environmentId === anchorRef.environmentId &&
    shell.archivedAt === null &&
    shell.deletedAt === null &&
    shell.sideChat?.anchor.threadId === anchorRef.threadId
  );
}

/** The live side chats that highlight text in `messageId` of the anchor thread, oldest first. */
export function selectSideChatMarks(
  anchorRef: ScopedThreadRef,
  messageId: MessageId,
  shells: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<SideChatMark> {
  const marks: { readonly createdAt: string; readonly mark: SideChatMark }[] = [];
  for (const shell of shells) {
    const sideChat = shell.sideChat;
    if (!sideChat || sideChat.anchor.messageId !== messageId) continue;
    if (!isLiveSideChatAnchoredIn(shell, anchorRef)) continue;
    marks.push({
      createdAt: shell.createdAt,
      mark: {
        threadId: shell.id,
        label: sideChat.label,
        state: sideChat.state,
        anchor: sideChat.anchor,
      },
    });
  }
  marks.sort((left, right) =>
    left.createdAt === right.createdAt ? 0 : left.createdAt < right.createdAt ? -1 : 1,
  );
  return marks.map((entry) => entry.mark);
}

export function sideChatMarksEqual(
  left: ReadonlyArray<SideChatMark>,
  right: ReadonlyArray<SideChatMark>,
): boolean {
  return (
    left.length === right.length &&
    left.every((mark, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        mark.threadId === other.threadId &&
        mark.label === other.label &&
        mark.state === other.state &&
        mark.anchor.threadId === other.anchor.threadId &&
        mark.anchor.messageId === other.anchor.messageId &&
        mark.anchor.start === other.anchor.start &&
        mark.anchor.end === other.anchor.end &&
        mark.anchor.prefix === other.anchor.prefix &&
        mark.anchor.suffix === other.anchor.suffix
      );
    })
  );
}

/**
 * The side chats anchored anywhere in one thread, filtered from the quiet shells
 * once so each of its rows only slices this short list.
 */
const sideChatAnchorShellsAtomFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  let previous: ReadonlyArray<EnvironmentThreadShell> = [];
  return Atom.make((get) => {
    const next = get(environmentThreadShells.quietThreadShellsAtom).filter((shell) =>
      isLiveSideChatAnchoredIn(shell, ref),
    );
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-side-chat-anchor-shells:${key}`));
});

const SIDE_CHAT_MARKS_KEY_SEPARATOR = "\u001f";

/** Held while the message's marks draw the same, so a side chat's own updates do not repaint its row. */
const sideChatMarksAtomFamily = Atom.family((key: string) => {
  const separator = key.lastIndexOf(SIDE_CHAT_MARKS_KEY_SEPARATOR);
  const anchorKey = key.slice(0, separator);
  const ref = parseThreadKey(anchorKey);
  const messageId = MessageId.make(key.slice(separator + 1));
  let previous = EMPTY_SIDE_CHAT_MARKS;
  return Atom.make((get) => {
    const next = selectSideChatMarks(
      ref,
      messageId,
      get(sideChatAnchorShellsAtomFamily(anchorKey)),
    );
    if (sideChatMarksEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-side-chat-marks:${key}`));
});

export function useSideChatMarks(
  anchorRef: ScopedThreadRef | null,
  messageId: MessageId,
): ReadonlyArray<SideChatMark> {
  return useAtomValue(
    anchorRef === null
      ? EMPTY_SIDE_CHAT_MARKS_ATOM
      : sideChatMarksAtomFamily(
          `${threadKey(anchorRef)}${SIDE_CHAT_MARKS_KEY_SEPARATOR}${messageId}`,
        ),
  );
}

const EMPTY_SIDE_CHAT_NOTE_DELIVERED_ATOM = Atom.make<boolean | null>(null).pipe(
  Atom.withLabel("web-side-chat-note-delivered:empty"),
);
const SIDE_CHAT_NOTE_DELIVERED_KEY_SEPARATOR = "\u001f";

/** One answer from the parent's structure, so the parent's other updates do not re-render readers. */
const sideChatNoteDeliveredAtomFamily = Atom.family((key: string) => {
  const [parentKey = "", sideChatId = "", requestId = ""] = key.split(
    SIDE_CHAT_NOTE_DELIVERED_KEY_SEPARATOR,
  );
  const parentRef = parseThreadKey(parentKey);
  const childId = ThreadId.make(sideChatId);
  return Atom.make((get) => {
    const parent = get(environmentThreadDetails.quietThreadAtom(parentRef));
    if (parent === null) return null;
    return parent.projection.thread.sideChatNoteDeliveries?.[childId] === requestId;
  }).pipe(Atom.withLabel(`web-side-chat-note-delivered:${key}`));
});

/** Whether the parent received the side chat's note `requestId`; null until the parent's detail loads. */
export function useSideChatNoteDelivered(
  parentRef: ScopedThreadRef | null,
  sideChatId: ThreadId,
  requestId: string,
): boolean | null {
  return useAtomValue(
    parentRef === null
      ? EMPTY_SIDE_CHAT_NOTE_DELIVERED_ATOM
      : sideChatNoteDeliveredAtomFamily(
          [threadKey(parentRef), sideChatId, requestId].join(
            SIDE_CHAT_NOTE_DELIVERED_KEY_SEPARATOR,
          ),
        ),
  );
}
