import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  deriveThreadQueueWorkflowState,
  getUserQueuedThreadRuns,
  type ThreadQueueWorkflowState,
} from "./threadWorkflows.ts";
import type { EnvironmentThread } from "./models.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";
import { derivePendingThreadRequests, type PendingThreadRequests } from "./threadRequests.ts";
import { arrayElementsEqual, parseThreadKey, threadKey } from "./entities.ts";

const EMPTY_VISIBLE_TURN_ITEMS: OrchestrationV2ThreadProjection["visibleTurnItems"] = Object.freeze(
  [],
);

export function createEnvironmentThreadDetailAtoms<E>(
  threadStateAtom: (
    environmentId: ScopedThreadRef["environmentId"],
    threadId: ScopedThreadRef["threadId"],
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>,
) {
  const threadStateValueAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(threadStateAtom(ref.environmentId, ref.threadId))),
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

  const visibleTurnItemsAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): OrchestrationV2ThreadProjection["visibleTurnItems"] =>
        Option.getOrNull(get(threadStateValueAtomFamily(key)).data)?.visibleTurnItems ??
        EMPTY_VISIBLE_TURN_ITEMS,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-visible-turn-items:${key}`)),
  );

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
    pendingRequestsAtom: (ref: ScopedThreadRef) => pendingRequestsAtomFamily(threadKey(ref)),
    queueWorkflowAtom: (ref: ScopedThreadRef) => queueWorkflowAtomFamily(threadKey(ref)),
    queuedCountAtom: (ref: ScopedThreadRef) => queuedCountAtomFamily(threadKey(ref)),
    stateAtom: (ref: ScopedThreadRef) => threadStateValueAtomFamily(threadKey(ref)),
    threadAtom: (ref: ScopedThreadRef) => threadAtomFamily(threadKey(ref)),
    visibleTurnItemsAtom: (ref: ScopedThreadRef) => visibleTurnItemsAtomFamily(threadKey(ref)),
    statusAtom: (ref: ScopedThreadRef) => statusAtomFamily(threadKey(ref)),
    errorAtom: (ref: ScopedThreadRef) => errorAtomFamily(threadKey(ref)),
    historyAtom: (ref: ScopedThreadRef) => historyAtomFamily(threadKey(ref)),
  };
}
