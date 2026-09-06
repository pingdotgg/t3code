import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import { Atom } from "effect/unstable/reactivity";

import {
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "../features/threads/threadOrder";
import { getThreadListV2OrderedSection } from "../features/threads/threadListV2";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";
import { queuedThreadKeysAtom } from "./use-thread-outbox";

export const pendingThreadOrderAtom = Atom.make<PendingThreadOrder | null>(null).pipe(
  Atom.keepAlive,
);

export function usePendingThreadOrder(nowMinute: string, snoozeWakeTick: number) {
  const pending = useAtomValue(pendingThreadOrderAtom);
  // A timed wake can change section membership without a shell event. Use the
  // lists' existing clocks to retire that hold and re-enable their move menus.
  useEffect(() => {
    getPendingThreadOrder();
  }, [nowMinute, snoozeWakeTick]);
  return pending;
}

let refreshPendingOrder: (() => void) | undefined;

/** Shared by Home and the navigation sidebar, including their action guards. */
export function getPendingThreadOrder(): PendingThreadOrder | null {
  refreshPendingOrder?.();
  return appAtomRegistry.get(pendingThreadOrderAtom);
}

export function beginPendingThreadOrder(pending: PendingThreadOrder) {
  const unsubscribers: (() => void)[] = [];
  const cancel = () => {
    if (refreshPendingOrder !== refresh) return;
    refreshPendingOrder = undefined;
    for (const unsubscribe of unsubscribers) unsubscribe();
    appAtomRegistry.set(pendingThreadOrderAtom, null);
  };
  const refresh = () => {
    if (refreshPendingOrder !== refresh) return;
    const current = appAtomRegistry.get(pendingThreadOrderAtom);
    if (current === null) return;
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    const ordered = getThreadListV2OrderedSection({
      threads: appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
      section: current.section,
      now: new Date().toISOString(),
      queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
      settlementEnvironmentIds: new Set(
        [...configs].flatMap(([id, config]) =>
          config.environment.capabilities.threadSettlement === true ? [id] : [],
        ),
      ),
      snoozeEnvironmentIds: new Set(
        [...configs].flatMap(([id, config]) =>
          config.environment.capabilities.threadSnooze === true ? [id] : [],
        ),
      ),
    });
    const next = reconcilePendingThreadOrder(current, ordered);
    if (next === null) cancel();
    else if (next !== current) appAtomRegistry.set(pendingThreadOrderAtom, next);
  };
  refreshPendingOrder = refresh;
  appAtomRegistry.set(pendingThreadOrderAtom, pending);
  unsubscribers.push(
    appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, refresh),
    appAtomRegistry.subscribe(environmentServerConfigsAtom, refresh),
    appAtomRegistry.subscribe(queuedThreadKeysAtom, refresh),
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
