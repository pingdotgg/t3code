import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import { Atom } from "effect/reactivity";

import {
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "../features/threads/threadOrder";
import { getThreadListV2OrderedSection } from "../features/threads/threadListV2";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";
import { queuedThreadKeysAtom } from "./use-thread-outbox";

export const threadArrangementOpenAtom = Atom.make(false).pipe(Atom.keepAlive);

export const threadDropBusyAtom = Atom.make(false).pipe(Atom.keepAlive);

export const pendingThreadOrderAtom = Atom.make<PendingThreadOrder | null>(null).pipe(
  Atom.keepAlive,
);

export function usePendingThreadOrder(nowMinute: string, snoozeWakeTick: number) {
  const pending = useAtomValue(pendingThreadOrderAtom);
  // Clock-driven wakes can change membership without shell events; retire order holds and re-enable moves then.
  useEffect(() => {
    getPendingThreadOrder();
  }, [nowMinute, snoozeWakeTick]);
  return pending;
}

let refreshPendingOrder: (() => void) | undefined;

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
