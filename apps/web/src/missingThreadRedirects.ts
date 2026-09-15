/**
 * Explicit redirect provenance for the thread route's missing-thread guard.
 *
 * When route data proves a thread gone and the guard navigates away, it
 * records the thread here so listeners can tell that authoritative redirect
 * apart from any user-initiated navigation that happens to land on "/".
 * Nothing else may record: the guard is the only provenance source.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface MissingThreadRedirect {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const listeners = new Set<(redirect: MissingThreadRedirect) => void>();

export function recordMissingThreadRedirect(redirect: MissingThreadRedirect): void {
  for (const listener of listeners) {
    listener(redirect);
  }
}

export function subscribeMissingThreadRedirect(
  listener: (redirect: MissingThreadRedirect) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
