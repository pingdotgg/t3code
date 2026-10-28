import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";

/**
 * Resolves true once the thread's shell reaches this client, or false after `timeoutMs`.
 * A thread the server just created arrives through the shell stream a moment after the
 * command returns, and the thread route treats a missing shell as an unavailable thread.
 */
export function waitForThreadShell(ref: ScopedThreadRef, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (found: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(found);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    unsubscribe = appAtomRegistry.subscribe(
      environmentThreadShells.threadShellAtom(ref),
      (shell) => {
        if (shell !== null) finish(true);
      },
      { immediate: true },
    );
    // `immediate` can settle before `unsubscribe` is assigned.
    if (settled) unsubscribe();
  });
}
