import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

const EVENT_NAME = "t3code:thread-rename";

/** Routes the active thread shortcut to its existing inline title editor. */
export function requestThreadRename(threadRef: ScopedThreadRef): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: scopedThreadKey(threadRef) }));
}

export function subscribeThreadRename(
  threadRef: ScopedThreadRef,
  listener: () => void,
): () => void {
  const key = scopedThreadKey(threadRef);
  const handler = (event: Event) => {
    if ((event as CustomEvent<string>).detail === key) listener();
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
