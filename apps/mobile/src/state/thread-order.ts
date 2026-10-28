import { useAtomValue } from "@effect/atom-react";
import { deadlineStore, minuteTick } from "@t3tools/client-runtime/clock";
import { Atom } from "effect/reactivity";

import {
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "../features/threads/threadOrder";
import {
  getThreadListV2OrderedSection,
  nextSnoozeWakeAfter,
} from "../features/threads/threadListV2";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";
import { queuedThreadKeysAtom } from "./use-thread-outbox";

export const threadArrangementOpenAtom = Atom.make(false).pipe(Atom.keepAlive);

export const threadDropBusyAtom = Atom.make(false).pipe(Atom.keepAlive);

export const pendingThreadOrderAtom = Atom.make<PendingThreadOrder | null>(null).pipe(
  Atom.keepAlive,
);

export function usePendingThreadOrder() {
  return useAtomValue(pendingThreadOrderAtom);
}

let refreshPendingOrder: (() => void) | undefined;
// Only one hold is live at a time; starting another tears down the previous
// hold's subscriptions so its clocks and listeners do not outlive it.
let teardownPendingOrder: (() => void) | undefined;

export function getPendingThreadOrder(): PendingThreadOrder | null {
  refreshPendingOrder?.();
  return appAtomRegistry.get(pendingThreadOrderAtom);
}

export function beginPendingThreadOrder(pending: PendingThreadOrder) {
  const unsubscribers: (() => void)[] = [];
  // A timed wake can change section membership without a shell event, so the
  // hold also re-checks on each minute and at the next snooze expiry.
  let wake: { readonly atMs: number | null; readonly unsubscribe: () => void } | null = null;
  const armWake = (atMs: number | null) => {
    if (wake?.atMs === atMs) return;
    wake?.unsubscribe();
    wake = { atMs, unsubscribe: deadlineStore(atMs).subscribe(refresh) };
  };
  const teardown = () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    wake?.unsubscribe();
    wake = null;
  };
  const cancel = () => {
    if (refreshPendingOrder !== refresh) return;
    refreshPendingOrder = undefined;
    teardownPendingOrder = undefined;
    teardown();
    appAtomRegistry.set(pendingThreadOrderAtom, null);
  };
  const refresh = () => {
    if (refreshPendingOrder !== refresh) return;
    const current = appAtomRegistry.get(pendingThreadOrderAtom);
    if (current === null) return;
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    const threads = appAtomRegistry.get(environmentThreadShells.navigationThreadShellsAtom);
    const nowMs = Date.now();
    const ordered = getThreadListV2OrderedSection({
      threads,
      section: current.section,
      now: new Date(nowMs).toISOString(),
      queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
      settlementEnvironmentIds: new Set(configs.keys()),
      snoozeEnvironmentIds: new Set(configs.keys()),
    });
    const next = reconcilePendingThreadOrder(current, ordered);
    if (next === null) {
      cancel();
      return;
    }
    if (next !== current) appAtomRegistry.set(pendingThreadOrderAtom, next);
    armWake(nextSnoozeWakeAfter(threads, nowMs));
  };
  teardownPendingOrder?.();
  refreshPendingOrder = refresh;
  teardownPendingOrder = teardown;
  appAtomRegistry.set(pendingThreadOrderAtom, pending);
  unsubscribers.push(
    appAtomRegistry.subscribe(environmentThreadShells.navigationThreadShellsAtom, refresh),
    appAtomRegistry.subscribe(environmentServerConfigsAtom, refresh),
    appAtomRegistry.subscribe(queuedThreadKeysAtom, refresh),
    minuteTick.subscribe(refresh),
  );
  armWake(
    nextSnoozeWakeAfter(
      appAtomRegistry.get(environmentThreadShells.navigationThreadShellsAtom),
      Date.now(),
    ),
  );
  return {
    isPending: () => {
      refresh();
      return refreshPendingOrder === refresh;
    },
    complete: () => {
      if (refreshPendingOrder !== refresh) return;
      const current = appAtomRegistry.get(pendingThreadOrderAtom);
      if (current !== null) {
        appAtomRegistry.set(pendingThreadOrderAtom, { ...current, commandsComplete: true });
        refresh();
      }
    },
    cancel,
  };
}
