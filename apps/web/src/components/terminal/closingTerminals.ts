import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

// Lifecycle commands run in order, so a queued close ends whichever shell holds its ID by then.
const closingIdsByThread = new Map<string, Map<string, number>>();

/** IDs a new terminal must not take until their pending closes settle. */
export function closingTerminalIds(threadRef: ScopedThreadRef): ReadonlyArray<string> {
  return [...(closingIdsByThread.get(scopedThreadKey(threadRef))?.keys() ?? [])];
}

export async function holdTerminalIdWhileClosing<A>(
  threadRef: ScopedThreadRef,
  terminalId: string,
  close: () => Promise<A>,
): Promise<A> {
  const key = scopedThreadKey(threadRef);
  const closing = closingIdsByThread.get(key) ?? new Map<string, number>();
  closingIdsByThread.set(key, closing);
  closing.set(terminalId, (closing.get(terminalId) ?? 0) + 1);
  try {
    return await close();
  } finally {
    const remaining = (closing.get(terminalId) ?? 1) - 1;
    if (remaining > 0) closing.set(terminalId, remaining);
    else closing.delete(terminalId);
    if (closing.size === 0) closingIdsByThread.delete(key);
  }
}
