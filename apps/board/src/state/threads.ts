import { useAtomValue } from "@effect/atom-react";
import { interruptThreadTurn, startThreadTurn } from "@t3tools/client-runtime/operations";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import {
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const startTurn = createEnvironmentCommand(connectionAtomRuntime, {
  label: "board:thread:start-turn",
  execute: startThreadTurn,
});

export const interruptTurn = createEnvironmentCommand(connectionAtomRuntime, {
  label: "board:thread:interrupt-turn",
  execute: interruptThreadTurn,
});

/** A thread's live state, which the engine streams while the thread is mounted. */
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);

const NO_THREAD = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("board-thread:none"),
);

/** The thread's live state, or an empty one for a board whose orchestrator has not started. */
export function useEnvironmentThread(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    threadId === null ? NO_THREAD : environmentThreads.stateAtom(environmentId, threadId),
  );
  return AsyncResult.getOrElse(result, () => EMPTY_ENVIRONMENT_THREAD_STATE);
}
