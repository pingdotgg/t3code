import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import { createThreadHandoffEnvironmentAtoms } from "@t3tools/client-runtime/state/peerLinks";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";

export const threadHandoffEnvironment = createThreadHandoffEnvironmentAtoms(connectionAtomRuntime);

/** Whether `environmentId` offers links and this client may move its threads over one. */
export const canMoveThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      offersLinkedEnvironments(
        get(environmentPresentations.serverConfigsAtom).get(environmentId),
      ) && get(threadHandoffEnvironment.start.permissionAtom(environmentId)),
  ).pipe(Atom.withLabel(`thread-handoff:available:${environmentId}`)),
);

export function readCanMoveThreads(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(canMoveThreadsAtom(environmentId));
}

/**
 * Which thread has the "Continue on another machine" dialog open. The thread menu and the
 * command palette both close as their command runs, so the root renders the dialog once.
 */
export const threadHandoffDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-handoff:dialog-thread"),
);

export function openThreadHandoffDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(threadHandoffDialogThreadAtom, threadRef);
}

/** Failed moves whose notice the user closed. The thread keeps the failure until it moves again. */
export const dismissedThreadHandoffsAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-handoff:dismissed"),
);
