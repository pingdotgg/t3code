/**
 * Sidebar highlights for threads that changed while the user was away.
 *
 * Do Not Disturb can swallow the notification banner entirely, and Electron
 * exposes no way to know whether that happened. So the alert has to survive
 * being missed: when a thread completes or fails without the user watching it,
 * its sidebar row is marked, and the mark stays until they actually open the
 * thread. Coming back from another app, another Space, or a Focus mode, the
 * sidebar itself says what happened and where — even if nothing was ever
 * shown or heard.
 *
 * State is deliberately in-memory. A highlight answers "what happened while I
 * was away just now"; restoring week-old marks on launch would be noise.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/** Green for a finished task, red for a failed one. */
export type ThreadAlertKind = "completed" | "failed";

const EMPTY_ALERTS: Readonly<Record<string, ThreadAlertKind>> = Object.freeze({});

const threadAlertsAtom = Atom.make<Readonly<Record<string, ThreadAlertKind>>>(EMPTY_ALERTS).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-thread-alerts"),
);

export function markThreadAlert(ref: ScopedThreadRef, kind: ThreadAlertKind): void {
  const key = scopedThreadKey(ref);
  const current = appAtomRegistry.get(threadAlertsAtom);
  // A failure outranks a completion for the same thread: if both land before
  // the user looks, the failure is the one they need to see.
  if (current[key] === kind || (current[key] === "failed" && kind === "completed")) {
    return;
  }
  appAtomRegistry.set(threadAlertsAtom, { ...current, [key]: kind });
}

export function clearThreadAlert(ref: ScopedThreadRef): void {
  const key = scopedThreadKey(ref);
  const current = appAtomRegistry.get(threadAlertsAtom);
  if (current[key] === undefined) {
    return;
  }
  const { [key]: _cleared, ...rest } = current;
  appAtomRegistry.set(threadAlertsAtom, rest);
}

export function readThreadAlert(ref: ScopedThreadRef): ThreadAlertKind | null {
  return appAtomRegistry.get(threadAlertsAtom)[scopedThreadKey(ref)] ?? null;
}

/**
 * The highlight for one thread row. Reads the whole map rather than a
 * per-thread atom family: the map is small (only unseen alerts), and a family
 * would allocate an atom per thread in the sidebar for a value that is
 * almost always absent.
 */
export function useThreadAlert(ref: ScopedThreadRef | null): ThreadAlertKind | null {
  const alerts = useAtomValue(threadAlertsAtom);
  return ref === null ? null : (alerts[scopedThreadKey(ref)] ?? null);
}

export function useHasThreadAlerts(): boolean {
  return Object.keys(useAtomValue(threadAlertsAtom)).length > 0;
}

/** Test-only reset so specs do not leak highlights into each other. */
export function __resetThreadAlertsForTests(): void {
  appAtomRegistry.set(threadAlertsAtom, EMPTY_ALERTS);
}
