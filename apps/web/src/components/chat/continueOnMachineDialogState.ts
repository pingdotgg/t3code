import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Which thread is moving to another machine. The thread menu and the command palette both
 * close as their command runs, so the root renders the dialog once.
 */
export const continueOnMachineThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("continue-on-machine:dialog-thread"),
);

export function openContinueOnMachineDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(continueOnMachineThreadAtom, threadRef);
}
