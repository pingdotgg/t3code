import { createChildThreadApprovalsAtom } from "@t3tools/client-runtime/state/thread-requests";
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
import { createSteadyShellAtoms } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
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
import { serverEnvironment } from "./server";
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
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
});
const steadyShells = createSteadyShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
  shellStateAtom: environmentShell.stateValueAtom,
  rowActionsAtom: threadEnvironment.rowActionsAtom,
  connectionStateAtom: environmentCatalog.stateAtom,
});
/**
 * The threads that lists arrange. Rows wait while their environment synchronizes, so a list
 * changes once when environments connect, not once per environment.
 */
export const steadyShellsHoldingAtom = steadyShells.holdingAtom;
export const steadyNavigationThreadShellsAtom = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: steadyShells.snapshotAtom,
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
}).navigationThreadShellsAtom;
export const childThreadApprovalsAtom = createChildThreadApprovalsAtom({
  childThreadInputsAtom: environmentThreadShells.childThreadInputsAtom,
  pendingRequestsAtom: environmentThreadDetails.pendingRequestsAtom,
});

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

/**
 * Keeps the open thread's family in the shell rows until its screen leaves. Shells leave idle
 * subagents out, so the rows of the thread, of its parents and of its subagents may exist only
 * there. Pass the ref the detail is read by: a thread still being created has no family to read.
 */
export function useOpenThreadFamily(ref: ScopedThreadRef | null) {
  const environmentId = ref?.environmentId ?? null;
  const threadId = ref?.threadId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the open thread's family in the thread family registry until the screen leaves it
  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    return threadFamilies.mount(appAtomRegistry, environmentId, threadId);
  }, [environmentId, threadId]);
}

/** The thread a loaded detail holds, cached or live; null while it holds none. */
export function loadedEnvironmentThread(environmentId: EnvironmentId, threadId: ThreadId) {
  const state = AsyncResult.getOrElse(
    appAtomRegistry.get(environmentThreads.stateAtom(environmentId, threadId)),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  );
  return Option.getOrNull(state.data)?.thread ?? null;
}
