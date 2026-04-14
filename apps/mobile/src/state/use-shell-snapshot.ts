import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_SHELL_SNAPSHOT_ATOM,
  EMPTY_SHELL_SNAPSHOT_STATE,
  createShellSnapshotManager,
  getShellSnapshotTargetKey,
  shellSnapshotStateAtom,
  type ShellSnapshotState,
} from "@t3tools/client-runtime";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import { appAtomRegistry } from "./atom-registry";

export const shellSnapshotManager = createShellSnapshotManager({
  getRegistry: () => appAtomRegistry,
});

export function useShellSnapshot(environmentId: string | null): ShellSnapshotState {
  const targetKey = getShellSnapshotTargetKey({ environmentId });
  const state = useAtomValue(
    targetKey !== null ? shellSnapshotStateAtom(targetKey) : EMPTY_SHELL_SNAPSHOT_ATOM,
  );
  return targetKey === null ? EMPTY_SHELL_SNAPSHOT_STATE : state;
}

export function useShellSnapshotStates(
  environmentIds: ReadonlyArray<string>,
): Readonly<Record<string, ShellSnapshotState>> {
  const stableEnvironmentIds = useMemo(
    () => Arr.sort(new Set(environmentIds), Order.String),
    [environmentIds],
  );
  const snapshotCacheRef = useRef<Readonly<Record<string, ShellSnapshotState>>>({});

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubs = stableEnvironmentIds.map((environmentId) =>
        appAtomRegistry.subscribe(shellSnapshotStateAtom(environmentId), onStoreChange),
      );
      return () => {
        for (const unsub of unsubs) {
          unsub();
        }
      };
    },
    [stableEnvironmentIds],
  );

  const getSnapshot = useCallback(() => {
    const previous = snapshotCacheRef.current;
    let hasChanged = Object.keys(previous).length !== stableEnvironmentIds.length;
    const next: Record<string, ShellSnapshotState> = {};

    for (const environmentId of stableEnvironmentIds) {
      const snapshot = shellSnapshotManager.getSnapshot({ environmentId });
      next[environmentId] = snapshot;
      if (!hasChanged && previous[environmentId] !== snapshot) {
        hasChanged = true;
      }
    }

    if (!hasChanged) {
      return previous;
    }

    snapshotCacheRef.current = next;
    return next;
  }, [stableEnvironmentIds]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
