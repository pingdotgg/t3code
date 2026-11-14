import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";

const TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 40;

/** Resolves true once a thread this client just created, such as a fork, reaches its state. */
export async function waitForThreadShell(ref: ScopedThreadRef): Promise<boolean> {
  const atom = environmentThreadShells.threadShellAtom(ref);
  const read = () => appAtomRegistry.get(atom) !== null;
  const deadline = Date.now() + TIMEOUT_MS;
  while (!read() && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
    });
  }
  return read();
}
