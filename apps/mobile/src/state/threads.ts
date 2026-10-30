import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createOlderSettledThreadAtoms,
  createThreadEnvironmentAtoms,
  createThreadFamilyAtoms,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import {
  pendingThreadCreationOutcomesAtom,
  selectThreadCreationDetail,
} from "./pending-thread-creation";
import { environmentShell } from "./shell";
import { threadOutboxManager } from "./thread-outbox";

export const threadFamilies = createThreadFamilyAtoms(
  connectionAtomRuntime,
  environmentShell.stateAtom,
);
export const olderSettledThreads = createOlderSettledThreadAtoms(
  connectionAtomRuntime,
  environmentShell.stateAtom,
);
export const threadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  threadFamilies.snapshotAtom,
);
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});

/** Keeps the subagent tree under `rootThreadId` in the thread list while the caller shows it. */
export function useThreadFamily(
  environmentId: EnvironmentId | null,
  rootThreadId: ThreadId | null,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the subagent tree under the root thread into the shared thread registry while the caller shows it
  useEffect(() => {
    if (environmentId === null || rootThreadId === null) return;
    return threadFamilies.mount(appAtomRegistry, environmentId, rootThreadId);
  }, [environmentId, rootThreadId]);
}

// Long enough for the opened screen to subscribe; its subscription keeps the thread after this.
const OPENING_THREAD_HOLD_MS = 3_000;

/**
 * Starts loading a thread being opened before its screen renders and subscribes, which
 * otherwise waits for navigation to commit.
 */
export function startOpeningEnvironmentThread(environmentId: EnvironmentId, threadId: ThreadId) {
  // A thread whose creation is still queued would load as not found and stay deleted;
  // the opened screen loads it once creation is delivered.
  const { detailRef } = selectThreadCreationDetail({
    threadRef: { environmentId, threadId },
    threadKey: scopedThreadKey(environmentId, threadId),
    queuedMessagesByThreadKey: appAtomRegistry.get(
      threadOutboxManager.queuedMessagesByThreadKeyAtom,
    ),
    outcomes: appAtomRegistry.get(pendingThreadCreationOutcomesAtom),
  });
  if (detailRef === null) return;
  const release = appAtomRegistry.mount(environmentThreads.stateAtom(environmentId, threadId));
  setTimeout(release, OPENING_THREAD_HOLD_MS);
}

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
  const state = AsyncResult.getOrElse(
    result,
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
  return state;
}
