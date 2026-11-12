import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Which thread has the guest share dialog open. The thread menu and the command palette both
 * close as their command runs, so the chat view renders the dialog once.
 */
export const guestShareDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("guest-share:dialog-thread"),
);

export function openGuestShareDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(guestShareDialogThreadAtom, threadRef);
}
