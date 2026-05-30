import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_ENVIRONMENT_RUNTIME_ATOM,
  EMPTY_ENVIRONMENT_RUNTIME_STATE,
  createEnvironmentRuntimeManager,
  environmentRuntimeStateAtom,
  getEnvironmentRuntimeTargetKey,
  type EnvironmentRuntimeState,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import { appAtomRegistry } from "./atom-registry";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export const environmentRuntimeManager = createEnvironmentRuntimeManager({
  getRegistry: () => appAtomRegistry,
});

export function useEnvironmentRuntime(
  environmentId: EnvironmentId | null,
): EnvironmentRuntimeState {
  const targetKey = getEnvironmentRuntimeTargetKey({ environmentId });
  const state = useAtomValue(
    targetKey !== null ? environmentRuntimeStateAtom(targetKey) : EMPTY_ENVIRONMENT_RUNTIME_ATOM,
  );
  return targetKey === null ? EMPTY_ENVIRONMENT_RUNTIME_STATE : state;
}

export function useEnvironmentRuntimeStates(
  environmentIds: ReadonlyArray<EnvironmentId>,
): Readonly<Record<EnvironmentId, EnvironmentRuntimeState>> {
  const stableEnvironmentIds = useMemo(
    () => Arr.sort(new Set(environmentIds), Order.String),
    [environmentIds],
  );
  const snapshotCacheRef = useRef<Readonly<Record<EnvironmentId, EnvironmentRuntimeState>>>({});

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubs = stableEnvironmentIds.map((environmentId) =>
        appAtomRegistry.subscribe(environmentRuntimeStateAtom(environmentId), onStoreChange),
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
    const next: Record<EnvironmentId, EnvironmentRuntimeState> = {};

    for (const environmentId of stableEnvironmentIds) {
      const snapshot = environmentRuntimeManager.getSnapshot({ environmentId });
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
