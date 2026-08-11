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

/**
 * How long a highlight survives once the user is actually looking at the app.
 * Focus is the moment the signal has done its job, so it fades shortly after
 * rather than lingering as decoration.
 */
export const THREAD_ALERT_FOCUSED_TTL_MS = 3_000;

/**
 * Hard ceiling from when the alert was raised, regardless of focus. Bounds the
 * case where the window was already focused (the user was in another Space, or
 * simply looking away) so nothing can pulse indefinitely.
 */
export const THREAD_ALERT_MAX_TTL_MS = 5_000;

export interface ThreadAlert {
  readonly kind: ThreadAlertKind;
  /** When the alert was raised. */
  readonly markedAtMs: number;
  /** When the window first had focus while this alert was live, if it has. */
  readonly focusedAtMs: number | null;
}

const EMPTY_ALERTS: Readonly<Record<string, ThreadAlert>> = Object.freeze({});

const threadAlertsAtom = Atom.make<Readonly<Record<string, ThreadAlert>>>(EMPTY_ALERTS).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-thread-alerts"),
);

/**
 * Whether an alert has outlived both of its bounds.
 *
 * Pure and time-injected so the expiry rules are testable without waiting on
 * real clocks.
 */
export function isThreadAlertExpired(alert: ThreadAlert, nowMs: number): boolean {
  if (nowMs - alert.markedAtMs >= THREAD_ALERT_MAX_TTL_MS) {
    return true;
  }
  return alert.focusedAtMs !== null && nowMs - alert.focusedAtMs >= THREAD_ALERT_FOCUSED_TTL_MS;
}

export function markThreadAlert(
  ref: ScopedThreadRef,
  kind: ThreadAlertKind,
  options: { readonly nowMs: number; readonly windowFocused: boolean },
): void {
  const key = scopedThreadKey(ref);
  const current = appAtomRegistry.get(threadAlertsAtom);
  const existing = current[key];
  // A failure outranks a completion for the same thread: if both land before
  // the user looks, the failure is the one they need to see.
  if (existing !== undefined && existing.kind === "failed" && kind === "completed") {
    return;
  }
  appAtomRegistry.set(threadAlertsAtom, {
    ...current,
    [key]: {
      kind,
      markedAtMs: options.nowMs,
      // An alert raised while the window is already focused starts its focused
      // countdown immediately; there is no later focus event to start it.
      focusedAtMs: options.windowFocused ? options.nowMs : null,
    },
  });
}

/**
 * Starts the focused countdown for every live alert. Called when the window
 * regains focus; alerts already counting down keep their original deadline, so
 * clicking around does not keep pushing the fade out.
 */
export function markThreadAlertsFocused(nowMs: number): void {
  const current = appAtomRegistry.get(threadAlertsAtom);
  const keys = Object.keys(current);
  if (keys.length === 0) {
    return;
  }

  let changed = false;
  const next: Record<string, ThreadAlert> = {};
  for (const key of keys) {
    const alert = current[key];
    if (alert === undefined) {
      continue;
    }
    if (alert.focusedAtMs === null) {
      next[key] = { ...alert, focusedAtMs: nowMs };
      changed = true;
    } else {
      next[key] = alert;
    }
  }

  if (changed) {
    appAtomRegistry.set(threadAlertsAtom, next);
  }
}

/** Drops every alert that has outlived its bounds. */
export function pruneExpiredThreadAlerts(nowMs: number): void {
  const current = appAtomRegistry.get(threadAlertsAtom);
  const keys = Object.keys(current);
  if (keys.length === 0) {
    return;
  }

  const next: Record<string, ThreadAlert> = {};
  let removed = false;
  for (const key of keys) {
    const alert = current[key];
    if (alert === undefined) {
      continue;
    }
    if (isThreadAlertExpired(alert, nowMs)) {
      removed = true;
    } else {
      next[key] = alert;
    }
  }

  if (removed) {
    appAtomRegistry.set(threadAlertsAtom, next);
  }
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
  return appAtomRegistry.get(threadAlertsAtom)[scopedThreadKey(ref)]?.kind ?? null;
}

export function readThreadAlerts(): Readonly<Record<string, ThreadAlert>> {
  return appAtomRegistry.get(threadAlertsAtom);
}

/** Notifies when the live alert set changes, so expiry can be rescheduled. */
export function subscribeThreadAlerts(listener: () => void): () => void {
  return appAtomRegistry.subscribe(threadAlertsAtom, listener);
}

/**
 * The highlight for one thread row. Reads the whole map rather than a
 * per-thread atom family: the map is small (only unseen alerts), and a family
 * would allocate an atom per thread in the sidebar for a value that is
 * almost always absent.
 */
export function useThreadAlert(ref: ScopedThreadRef | null): ThreadAlertKind | null {
  const alerts = useAtomValue(threadAlertsAtom);
  return ref === null ? null : (alerts[scopedThreadKey(ref)]?.kind ?? null);
}

export function useHasThreadAlerts(): boolean {
  return Object.keys(useAtomValue(threadAlertsAtom)).length > 0;
}

/** Test-only reset so specs do not leak highlights into each other. */
export function __resetThreadAlertsForTests(): void {
  appAtomRegistry.set(threadAlertsAtom, EMPTY_ALERTS);
}
