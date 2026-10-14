import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";

// Matches the server's capture limit when the thread shell is not loaded.
const CAPTURE_FRAME_LEASE_MS = 5_000;
const leases = new Map<string, { release: () => void; unsubscribe: () => void }>();

/** Keeps a hidden page drawing through an active turn, or for one bounded capture. */
export function holdFramesForCapture(tabId: string, threadRef?: ScopedThreadRef): void {
  const previous = leases.get(tabId);
  previous?.unsubscribe();
  const release = previous?.release ?? acquireBrowserSurfaceActivity(tabId);
  const shellAtom = threadRef ? environmentThreadShells.threadShellAtom(threadRef) : null;
  if (shellAtom && threadRuntimeIsActive(appAtomRegistry.get(shellAtom)?.runtime)) {
    const unsubscribe = appAtomRegistry.subscribe(shellAtom, (shell) => {
      if (!threadRuntimeIsActive(shell?.runtime)) releaseCaptureFrames(tabId);
    });
    leases.set(tabId, { release, unsubscribe });
  } else {
    const timer = setTimeout(() => releaseCaptureFrames(tabId), CAPTURE_FRAME_LEASE_MS);
    leases.set(tabId, { release, unsubscribe: () => clearTimeout(timer) });
  }
}

/** Releases a frame lease when its native guest or host goes away. */
export function releaseCaptureFrames(tabId: string): void {
  const lease = leases.get(tabId);
  if (!lease) return;
  leases.delete(tabId);
  lease.unsubscribe();
  lease.release();
}
