import {
  OrchestrationV2AppThread,
  OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  deriveThreadQueueWorkflowState,
  getUserQueuedThreadRuns,
  type ThreadQueueWorkflowState,
} from "./threadWorkflows.ts";
import { deriveThreadTurnSubagents, type ThreadTurnSubagents } from "./threadSubagents.ts";
import {
  deriveThreadCheckpointSummaries,
  type ThreadCheckpointSummary,
} from "./threadCheckpoints.ts";
import type {
  EnvironmentThread,
  EnvironmentThreadStructure,
  ThreadStructure,
  ThreadStructureThread,
  ThreadStructureTurnItem,
  ThreadStructureVisibleTurnItem,
} from "./models.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";
import {
  createQuestionHistoryProjector,
  derivePendingThreadRequests,
  type PendingThreadRequests,
} from "./threadRequests.ts";
import { arrayElementsEqual, parseThreadKey, threadKey } from "./entities.ts";
import { getProjectionArrayReplacementIndex } from "./orchestrationV2Projection.ts";

const EMPTY_VISIBLE_TURN_ITEMS: OrchestrationV2ThreadProjection["visibleTurnItems"] = Object.freeze(
  [],
);
const EMPTY_THREAD_STRUCTURE_TURN_ITEMS: ReadonlyArray<ThreadStructureVisibleTurnItem> =
  Object.freeze([]);
const EMPTY_CHECKPOINT_SUMMARIES: ReadonlyArray<ThreadCheckpointSummary> = Object.freeze([]);

type TurnItem = OrchestrationV2ThreadProjection["turnItems"][number];
type VisibleTurnItem = OrchestrationV2ThreadProjection["visibleTurnItems"][number];
type AppThread = OrchestrationV2ThreadProjection["thread"];

// Items are stripped once each: unchanged items keep their identity across
// structure changes, which the incremental timeline relies on.
const structureTurnItems = new WeakMap<TurnItem, ThreadStructureTurnItem>();
const structureVisibleTurnItems = new WeakMap<VisibleTurnItem, ThreadStructureVisibleTurnItem>();

function toThreadStructureTurnItem(item: TurnItem): ThreadStructureTurnItem {
  if (item.type !== "assistant_message" && item.type !== "reasoning") return item;
  let structure = structureTurnItems.get(item);
  if (structure === undefined) {
    const { text: _text, updatedAt: _updatedAt, ...rest } = item;
    structure = rest;
    structureTurnItems.set(item, structure);
  }
  return structure;
}

function toThreadStructureVisibleTurnItem(
  visibleItem: VisibleTurnItem,
): ThreadStructureVisibleTurnItem {
  const item = toThreadStructureTurnItem(visibleItem.item);
  if (item === visibleItem.item) return visibleItem;
  let structure = structureVisibleTurnItems.get(visibleItem);
  if (structure === undefined) {
    structure = { ...visibleItem, item };
    structureVisibleTurnItems.set(visibleItem, structure);
  }
  return structure;
}

/** Whether the structure kept every field of this row: true for all but streamed items. */
export function isCompleteTurnItemRow(row: ThreadStructureVisibleTurnItem): row is VisibleTurnItem {
  return row.item.type !== "assistant_message" && row.item.type !== "reasoning";
}

// The open thread is marked visited several times while a reply streams. Visit
// state is read from the shell, or from lastVisitedAtAtom while the thread is
// not in the shell index yet, so a mark is not structure.
function toThreadStructureThread(thread: AppThread): ThreadStructureThread {
  const { updatedAt: _updatedAt, lastVisitedAt: _lastVisitedAt, ...structure } = thread;
  return structure;
}

function toThreadStructure(projection: OrchestrationV2ThreadProjection): ThreadStructure {
  const { updatedAt: _updatedAt, ...structure } = projection;
  return {
    ...structure,
    thread: toThreadStructureThread(projection.thread),
    turnItems: projection.turnItems.map(toThreadStructureTurnItem),
    visibleTurnItems: projection.visibleTurnItems.map(toThreadStructureVisibleTurnItem),
  };
}

const sameTurnItem = Schema.toEquivalence(OrchestrationV2TurnItem);
const sameAppThread = Schema.toEquivalence(OrchestrationV2AppThread);

// Overlays previous's structure on next, so the fields the strip functions
// remove are exactly the ones ignored here.
function sameApartFromStripped<T extends object>(
  same: (left: T, right: T) => boolean,
  previous: T,
  previousStructure: object,
  next: T,
): boolean {
  return (
    Object.keys(previous).length === Object.keys(next).length &&
    same(Object.assign({}, next, previousStructure), next)
  );
}

function sameTurnItemStructure(previous: TurnItem, next: TurnItem): boolean {
  if (previous === next) return true;
  const structure = toThreadStructureTurnItem(previous);
  if (previous.id !== next.id || previous.type !== next.type || structure === previous) {
    return false;
  }
  return sameApartFromStripped(sameTurnItem, previous, structure, next);
}

function sameProjectionArray<T>(
  previous: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
  same: (previous: T, next: T) => boolean,
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  const replacedIndex = getProjectionArrayReplacementIndex(previous, next);
  if (replacedIndex !== undefined) return same(previous[replacedIndex]!, next[replacedIndex]!);
  return previous.every((item, index) => same(item, next[index]!));
}

function sameVisibleTurnItemStructure(before: VisibleTurnItem, after: VisibleTurnItem): boolean {
  return (
    before === after ||
    (before.position === after.position &&
      before.visibility === after.visibility &&
      before.sourceThreadId === after.sourceThreadId &&
      before.sourceItemId === after.sourceItemId &&
      sameTurnItemStructure(before.item, after.item))
  );
}

/**
 * Whether `previous` and `next` have the same ThreadStructure: they differ
 * only by text streamed into existing assistant and reasoning items or by a
 * visit mark. The same items exist, with the same status, and every other
 * field is unchanged.
 */
export function sameThreadStructure(
  previous: OrchestrationV2ThreadProjection,
  next: OrchestrationV2ThreadProjection,
): boolean {
  if (previous === next) return true;
  for (const key of Object.keys(next) as Array<keyof OrchestrationV2ThreadProjection>) {
    if (
      key === "thread" ||
      key === "turnItems" ||
      key === "visibleTurnItems" ||
      key === "updatedAt"
    ) {
      continue;
    }
    if (previous[key] !== next[key]) return false;
  }
  if (
    previous.thread !== next.thread &&
    !sameApartFromStripped(
      sameAppThread,
      previous.thread,
      toThreadStructureThread(previous.thread),
      next.thread,
    )
  ) {
    return false;
  }
  return (
    sameProjectionArray(previous.turnItems, next.turnItems, sameTurnItemStructure) &&
    sameProjectionArray(
      previous.visibleTurnItems,
      next.visibleTurnItems,
      sameVisibleTurnItemStructure,
    )
  );
}

export function createEnvironmentThreadDetailAtoms<E>(
  threadStateAtom: (
    environmentId: ScopedThreadRef["environmentId"],
    threadId: ScopedThreadRef["threadId"],
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>,
) {
  const threadStateValueAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) =>
      AsyncResult.getOrElse(
        get(threadStateAtom(ref.environmentId, ref.threadId)),
        () => EMPTY_ENVIRONMENT_THREAD_STATE,
      ),
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-state-value:${key}`));
  });

  const threadAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previousProjection: OrchestrationV2ThreadProjection | null = null;
    let previousValue: EnvironmentThread | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === previousProjection) return previousValue;
      previousProjection = projection;
      previousValue = projection === null ? null : { environmentId: ref.environmentId, projection };
      return previousValue;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread:${key}`));
  });

  // Streamed assistant and reasoning text replaces an item several times a
  // second. Readers of the thread's structure (runs, requests, which items
  // exist and their status) keep the previous value through those updates.
  const quietThreadAtomFamily = Atom.family((key: string) => {
    let previousProjection: OrchestrationV2ThreadProjection | null = null;
    let previous: EnvironmentThreadStructure | null = null;
    return Atom.make((get) => {
      const next = get(threadAtomFamily(key));
      if (next === null) {
        previousProjection = null;
        previous = null;
      } else if (
        previousProjection === null ||
        !sameThreadStructure(previousProjection, next.projection)
      ) {
        previous = {
          environmentId: next.environmentId,
          projection: toThreadStructure(next.projection),
        };
      }
      // Comparing the latest projection lets consecutive replacements bypass history scans.
      previousProjection = next?.projection ?? null;
      return previous;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-quiet-thread:${key}`));
  });

  const visibleTurnItemsAtomFamily = Atom.family((key: string) => {
    const projectQuestionHistory = createQuestionHistoryProjector();
    return Atom.make((get): OrchestrationV2ThreadProjection["visibleTurnItems"] => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      return projection === null ? EMPTY_VISIBLE_TURN_ITEMS : projectQuestionHistory(projection);
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-visible-turn-items:${key}`));
  });

  const quietVisibleTurnItemsAtomFamily = Atom.family((key: string) => {
    const projectQuestionHistory = createQuestionHistoryProjector<ThreadStructureVisibleTurnItem>();
    return Atom.make((get) => {
      const thread = get(quietThreadAtomFamily(key));
      return thread === null
        ? EMPTY_THREAD_STRUCTURE_TURN_ITEMS
        : projectQuestionHistory(thread.projection);
    }).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-quiet-thread-visible-turn-items:${key}`),
    );
  });

  const queueWorkflowAtomFamily = Atom.family((key: string) => {
    let previous: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "messages" | "providerThreads" | "providerSessions" | "providerTurns"
    > | null = null;
    let value: ThreadQueueWorkflowState | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = null;
      } else if (
        previous === null ||
        projection.thread !== previous.thread ||
        projection.runs !== previous.runs ||
        projection.messages !== previous.messages ||
        projection.providerThreads !== previous.providerThreads ||
        projection.providerSessions !== previous.providerSessions ||
        projection.providerTurns !== previous.providerTurns
      ) {
        value = deriveThreadQueueWorkflowState(projection);
        const { thread, runs, messages, providerThreads, providerSessions, providerTurns } =
          projection;
        previous = { thread, runs, messages, providerThreads, providerSessions, providerTurns };
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-queue:${key}`));
  });
  const queuedCountAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "runs" | "messages"> | null = null;
    let count = 0;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        count = 0;
      } else if (projection.runs !== previous?.runs || projection.messages !== previous?.messages) {
        const { runs, messages } = projection;
        previous = { runs, messages };
        count = getUserQueuedThreadRuns(previous).length;
      }
      return count;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-queue-count:${key}`));
  });

  const turnSubagentsAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "runs" | "subagents"> | null = null;
    let value: ThreadTurnSubagents | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = null;
      } else if (
        projection.runs !== previous?.runs ||
        projection.subagents !== previous?.subagents
      ) {
        const { runs, subagents } = projection;
        previous = { runs, subagents };
        value = deriveThreadTurnSubagents(previous);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-turn-subagents:${key}`));
  });

  const checkpointSummariesAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "messages"> | null = null;
    let value = EMPTY_CHECKPOINT_SUMMARIES;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = EMPTY_CHECKPOINT_SUMMARIES;
      } else if (
        projection.checkpoints !== previous?.checkpoints ||
        projection.messages !== previous?.messages
      ) {
        const { checkpoints, messages } = projection;
        previous = { checkpoints, messages };
        value = deriveThreadCheckpointSummaries(previous);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-checkpoint-summaries:${key}`));
  });

  const lastVisitedAtAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get) =>
        Option.getOrNull(get(threadStateValueAtomFamily(key)).data)?.thread.lastVisitedAt ?? null,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-last-visited:${key}`)),
  );
  const updatedAtAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get) => Option.getOrNull(get(threadStateValueAtomFamily(key)).data)?.updatedAt ?? null,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-updated-at:${key}`)),
  );
  const worktreePathAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get) =>
        Option.getOrNull(get(threadStateValueAtomFamily(key)).data)?.thread.worktreePath ?? null,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-worktree:${key}`)),
  );
  const pendingRequestsAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems"> | null =
      null;
    let value: PendingThreadRequests | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = null;
        return value;
      }
      const runtimeRequests = projection.runtimeRequests.filter(
        (request) => request.status === "pending",
      );
      const ids = new Set(runtimeRequests.map((request) => request.id));
      const turnItems =
        ids.size === 0
          ? []
          : projection.turnItems.filter(
              (item) =>
                (item.type === "approval_request" || item.type === "user_input_request") &&
                ids.has(item.requestId),
            );
      if (
        previous === null ||
        !arrayElementsEqual(previous.runtimeRequests, runtimeRequests) ||
        !arrayElementsEqual(previous.turnItems, turnItems)
      ) {
        previous = { runtimeRequests, turnItems };
        value = derivePendingThreadRequests(previous);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-pending-requests:${key}`));
  });

  const statusAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).status).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-status:${key}`),
    ),
  );
  const errorAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => Option.getOrNull(get(threadStateValueAtomFamily(key)).error)).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-error:${key}`),
    ),
  );
  const historyAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).history).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-history:${key}`),
    ),
  );

  return {
    worktreePathAtom: (ref: ScopedThreadRef) => worktreePathAtomFamily(threadKey(ref)),
    updatedAtAtom: (ref: ScopedThreadRef) => updatedAtAtomFamily(threadKey(ref)),
    lastVisitedAtAtom: (ref: ScopedThreadRef) => lastVisitedAtAtomFamily(threadKey(ref)),
    pendingRequestsAtom: (ref: ScopedThreadRef) => pendingRequestsAtomFamily(threadKey(ref)),
    queueWorkflowAtom: (ref: ScopedThreadRef) => queueWorkflowAtomFamily(threadKey(ref)),
    queuedCountAtom: (ref: ScopedThreadRef) => queuedCountAtomFamily(threadKey(ref)),
    turnSubagentsAtom: (ref: ScopedThreadRef) => turnSubagentsAtomFamily(threadKey(ref)),
    checkpointSummariesAtom: (ref: ScopedThreadRef) =>
      checkpointSummariesAtomFamily(threadKey(ref)),
    stateAtom: (ref: ScopedThreadRef) => threadStateValueAtomFamily(threadKey(ref)),
    threadAtom: (ref: ScopedThreadRef) => threadAtomFamily(threadKey(ref)),
    quietThreadAtom: (ref: ScopedThreadRef) => quietThreadAtomFamily(threadKey(ref)),
    visibleTurnItemsAtom: (ref: ScopedThreadRef) => visibleTurnItemsAtomFamily(threadKey(ref)),
    quietVisibleTurnItemsAtom: (ref: ScopedThreadRef) =>
      quietVisibleTurnItemsAtomFamily(threadKey(ref)),
    statusAtom: (ref: ScopedThreadRef) => statusAtomFamily(threadKey(ref)),
    errorAtom: (ref: ScopedThreadRef) => errorAtomFamily(threadKey(ref)),
    historyAtom: (ref: ScopedThreadRef) => historyAtomFamily(threadKey(ref)),
  };
}
