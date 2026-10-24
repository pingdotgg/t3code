import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";

/** Enough for one capture when the thread is not running a turn. */
const CAPTURE_HOLD_MS = 10_000;
const holds = new Map<string, { readonly release: () => void; readonly stop: () => void }>();

/**
 * A hidden tab draws no frames, so the server's capture of it never finishes. Called when the
 * server captures a tab; keeps it drawing until its thread's turn ends.
 */
export function holdFramesForCapture(runtimeTabId: string, threadRef: ScopedThreadRef): void {
  const previous = holds.get(runtimeTabId);
  previous?.stop();
  const release = previous?.release ?? acquireBrowserSurfaceActivity(runtimeTabId);
  const end = () => {
    holds.delete(runtimeTabId);
    stop();
    release();
  };
  const shellAtom = environmentThreadShells.threadShellAtom(threadRef);
  let stop: () => void;
  if (threadRuntimeIsActive(appAtomRegistry.get(shellAtom)?.runtime)) {
    stop = appAtomRegistry.subscribe(shellAtom, (shell) => {
      if (!threadRuntimeIsActive(shell?.runtime)) end();
    });
  } else {
    const timer = setTimeout(end, CAPTURE_HOLD_MS);
    stop = () => clearTimeout(timer);
  }
  holds.set(runtimeTabId, { release, stop });
}
