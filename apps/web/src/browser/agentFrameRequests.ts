import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";

const leases = new Map<string, () => void>();

/**
 * Keeps a hidden tab drawing after the server asked for one of its frames, until
 * the thread's turn ends. A tab parked offscreen draws nothing, so an agent's
 * screenshot would wait forever. Later requests in the same turn reuse the lease.
 */
export function holdFramesForTurn(tabId: string, threadRef: ScopedThreadRef): void {
  if (leases.has(tabId)) return;
  const shellAtom = environmentThreadShells.threadShellAtom(threadRef);
  if (!threadRuntimeIsActive(appAtomRegistry.get(shellAtom)?.runtime)) return;
  const releaseActivity = acquireBrowserSurfaceActivity(tabId);
  const release = () => {
    leases.delete(tabId);
    unsubscribe();
    releaseActivity();
  };
  const unsubscribe = appAtomRegistry.subscribe(shellAtom, (shell) => {
    if (!threadRuntimeIsActive(shell?.runtime)) release();
  });
  leases.set(tabId, release);
}
