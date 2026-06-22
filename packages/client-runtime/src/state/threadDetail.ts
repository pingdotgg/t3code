import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type {
  EnvironmentThread,
  EnvironmentThreadShell,
  ThreadCheckpointSummary,
  ThreadConversationMessage,
  ThreadPendingApproval,
  ThreadPendingUserInput,
  ThreadProposedPlan,
  ThreadRunSummary,
  ThreadRuntimeSummary,
  ScopedThreadProjection,
  ThreadWorkEntry,
} from "./models.ts";
import { presentThread } from "./models.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threads.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";

const EMPTY_MESSAGES: ReadonlyArray<ThreadConversationMessage> = Object.freeze([]);
const EMPTY_WORK_ENTRIES: ReadonlyArray<ThreadWorkEntry> = Object.freeze([]);
const EMPTY_PROPOSED_PLANS: ReadonlyArray<ThreadProposedPlan> = Object.freeze([]);
const EMPTY_CHECKPOINTS: ReadonlyArray<ThreadCheckpointSummary> = Object.freeze([]);
const EMPTY_APPROVALS: ReadonlyArray<ThreadPendingApproval> = Object.freeze([]);
const EMPTY_USER_INPUTS: ReadonlyArray<ThreadPendingUserInput> = Object.freeze([]);
const EMPTY_VISIBLE_TURN_ITEMS: OrchestrationV2ThreadProjection["visibleTurnItems"] = Object.freeze(
  [],
);

/** Shell metadata wins over an independently cached detail projection. */
export function mergeEnvironmentThread(
  detail: EnvironmentThread | null,
  shell: EnvironmentThreadShell | null,
): EnvironmentThread | null {
  if (detail === null || shell === null) return detail;
  if (detail.environmentId !== shell.environmentId || detail.id !== shell.id) return detail;
  return {
    ...detail,
    ...shell,
    latestRun: detail.latestRun,
    runtime: detail.runtime,
    source: shell.source,
  };
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
      Option.getOrElse(
        AsyncResult.value(get(threadStateAtom(ref.environmentId, ref.threadId))),
        () => EMPTY_ENVIRONMENT_THREAD_STATE,
      ),
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-state-value:${key}`),
    );
  });

  const threadDetailAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previousSource: OrchestrationV2ThreadProjection | null = null;
    let previousValue: EnvironmentThread | null = null;
    return Atom.make((get) => {
      const source = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (source === previousSource) return previousValue;
      previousSource = source;
      previousValue = source === null ? null : presentThread(ref.environmentId, source);
      return previousValue;
    }).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-detail:${key}`),
    );
  });

  const scopedThreadProjectionAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previousProjection: OrchestrationV2ThreadProjection | null = null;
    let previousValue: ScopedThreadProjection | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === previousProjection) return previousValue;
      previousProjection = projection;
      previousValue = projection === null ? null : { environmentId: ref.environmentId, projection };
      return previousValue;
    }).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`scoped-thread-projection:${key}`),
    );
  });

  const visibleTurnItemsAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): OrchestrationV2ThreadProjection["visibleTurnItems"] =>
        Option.getOrNull(get(threadStateValueAtomFamily(key)).data)?.visibleTurnItems ??
        EMPTY_VISIBLE_TURN_ITEMS,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-visible-turn-items:${key}`),
    ),
  );

  const family = <A>(label: string, select: (thread: EnvironmentThread) => A, empty: A) =>
    Atom.family((key: string) =>
      Atom.make((get): A => {
        const thread = get(threadDetailAtomFamily(key));
        return thread === null ? empty : select(thread);
      }).pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-${label}:${key}`),
      ),
    );

  const messages = family("messages", (thread) => thread.messages, EMPTY_MESSAGES);
  const workEntries = family("work-entries", (thread) => thread.workEntries, EMPTY_WORK_ENTRIES);
  const proposedPlans = family(
    "proposed-plans",
    (thread) => thread.proposedPlans,
    EMPTY_PROPOSED_PLANS,
  );
  const checkpoints = family("checkpoints", (thread) => thread.checkpoints, EMPTY_CHECKPOINTS);
  const pendingApprovals = family(
    "pending-approvals",
    (thread) => thread.pendingApprovals,
    EMPTY_APPROVALS,
  );
  const pendingUserInputs = family(
    "pending-user-inputs",
    (thread) => thread.pendingUserInputs,
    EMPTY_USER_INPUTS,
  );
  const runtime = family<ThreadRuntimeSummary | null>("runtime", (thread) => thread.runtime, null);
  const latestRun = family<ThreadRunSummary | null>(
    "latest-run",
    (thread) => thread.latestRun,
    null,
  );

  const status = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).status).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-status:${key}`),
    ),
  );
  const error = Atom.family((key: string) =>
    Atom.make((get) => Option.getOrNull(get(threadStateValueAtomFamily(key)).error)).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-error:${key}`),
    ),
  );

  return {
    stateAtom: (ref: ScopedThreadRef) => threadStateValueAtomFamily(threadKey(ref)),
    threadAtom: (ref: ScopedThreadRef) => scopedThreadProjectionAtomFamily(threadKey(ref)),
    visibleTurnItemsAtom: (ref: ScopedThreadRef) => visibleTurnItemsAtomFamily(threadKey(ref)),
    detailAtom: (ref: ScopedThreadRef) => threadDetailAtomFamily(threadKey(ref)),
    statusAtom: (ref: ScopedThreadRef) => status(threadKey(ref)),
    errorAtom: (ref: ScopedThreadRef) => error(threadKey(ref)),
    messagesAtom: (ref: ScopedThreadRef) => messages(threadKey(ref)),
    workEntriesAtom: (ref: ScopedThreadRef) => workEntries(threadKey(ref)),
    proposedPlansAtom: (ref: ScopedThreadRef) => proposedPlans(threadKey(ref)),
    checkpointsAtom: (ref: ScopedThreadRef) => checkpoints(threadKey(ref)),
    pendingApprovalsAtom: (ref: ScopedThreadRef) => pendingApprovals(threadKey(ref)),
    pendingUserInputsAtom: (ref: ScopedThreadRef) => pendingUserInputs(threadKey(ref)),
    runtimeAtom: (ref: ScopedThreadRef) => runtime(threadKey(ref)),
    latestRunAtom: (ref: ScopedThreadRef) => latestRun(threadKey(ref)),
  };
}
