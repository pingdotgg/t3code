/**
 * Explicit redirect provenance for the thread route's missing-thread guard.
 *
 * When route data proves a thread gone and the guard navigates away, it
 * records the thread here so listeners can tell that authoritative redirect
 * apart from any user-initiated navigation that happens to land on "/".
 * Nothing else may record: the guard is the only provenance source.
 *
 * Recorded redirects are also retained in a bounded recent log with a
 * monotonic sequence. A consumer whose interest starts only after a
 * navigation begins (the voice navigator arms its live subscription at
 * acknowledgment) can snapshot the sequence at navigation start and ask
 * whether a matching provenance event was recorded in between, so an event
 * fired before any listener was armed is not lost when the redirect's route
 * transition commits after a successful-looking path read-back.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface MissingThreadRedirect {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const listeners = new Set<(redirect: MissingThreadRedirect) => void>();

/** Bounded recent log: plenty for concurrent voice + user navigations, small
    enough that retained entries never accumulate. */
const RECENT_LIMIT = 32;
const recent: { seq: number; redirect: MissingThreadRedirect }[] = [];
let seqCounter = 0;

export function recordMissingThreadRedirect(redirect: MissingThreadRedirect): void {
  const seq = ++seqCounter;
  recent.push({ seq, redirect });
  if (recent.length > RECENT_LIMIT) {
    recent.splice(0, recent.length - RECENT_LIMIT);
  }
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

/** Current high-water mark of recorded redirects; snapshot before an
    operation whose concurrent provenance events must not be missed. */
export function currentMissingThreadRedirectSeq(): number {
  return seqCounter;
}

/** Whether a redirect for exactly this thread was recorded after `sinceSeq`.
    Only an exact identity match counts; redirects for other threads are
    never evidence for this one. */
export function hasMissingThreadRedirectSince(
  redirect: MissingThreadRedirect,
  sinceSeq: number,
): boolean {
  return recent.some(
    (entry) =>
      entry.seq > sinceSeq &&
      entry.redirect.environmentId === redirect.environmentId &&
      entry.redirect.threadId === redirect.threadId,
  );
}
