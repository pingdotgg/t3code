import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { scopedThreadKey } from "../lib/scopedEntities";
import { environmentSnapshotAtom } from "./shell";
import { pendingThreadCreationOutcomesAtom } from "./pending-thread-creation";
import { threadOutboxManager } from "./thread-outbox";

export const threadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  environmentSnapshotAtom,
);
const remoteThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});

// Every detail reader must wait for creation, including queue/model/subagent
// atoms that read the stand-in shell without going through thread selection.
// An early HTTP miss parks the shared remote state as deleted until it is reopened.
const creationReadyAtom = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  const creationKey = scopedThreadKey(ref.environmentId, ref.threadId);
  return Atom.make((get) => {
    if (get(environmentThreadShells.threadShellAtom(ref)) !== null) return true;
    const outcome = get(pendingThreadCreationOutcomesAtom)[creationKey];
    if (outcome?.kind === "delivered") return true;
    const queued = get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[creationKey];
    return outcome === undefined && !queued?.some((message) => message.creation !== undefined);
  }).pipe(Atom.setIdleTTL(0));
});
const creationAwareStateAtom = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) =>
    get(creationReadyAtom(key))
      ? get(remoteThreads.stateAtom(ref.environmentId, ref.threadId))
      : AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE),
  ).pipe(Atom.setIdleTTL(0));
});
export const environmentThreads = {
  stateAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
    creationAwareStateAtom(threadKey({ environmentId, threadId })),
};
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("mobile-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  const state = Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
  return state;
}
