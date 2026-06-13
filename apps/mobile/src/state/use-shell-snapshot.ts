import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import {
  EMPTY_SHELL_SNAPSHOT_ATOM,
  EMPTY_SHELL_SNAPSHOT_STATE,
  createShellSnapshotManager,
  getShellSnapshotTargetKey,
  shellSnapshotStateAtom,
  type ShellSnapshotState,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import { appAtomRegistry } from "./atom-registry";
import type { CachedShellSnapshot } from "../lib/storage";

const cachedShellSnapshotMetadataAtom = Atom.make<
  Readonly<Record<EnvironmentId, { readonly snapshotReceivedAt: string }>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:cached-shell-snapshot-metadata"));

export const shellSnapshotManager = createShellSnapshotManager({
  getRegistry: () => appAtomRegistry,
});

export function hydrateCachedShellSnapshot(cached: CachedShellSnapshot): void {
  shellSnapshotManager.syncSnapshot({ environmentId: cached.environmentId }, cached.snapshot);
  appAtomRegistry.set(cachedShellSnapshotMetadataAtom, {
    ...appAtomRegistry.get(cachedShellSnapshotMetadataAtom),
    [cached.environmentId]: {
      snapshotReceivedAt: cached.snapshotReceivedAt,
    },
  });
}

export function markShellSnapshotLive(environmentId: EnvironmentId): void {
  const current = appAtomRegistry.get(cachedShellSnapshotMetadataAtom);
  if (current[environmentId] === undefined) {
    return;
  }

  const next = { ...current };
  delete next[environmentId];
  appAtomRegistry.set(cachedShellSnapshotMetadataAtom, next);
}

export function clearCachedShellSnapshotMetadata(environmentId: EnvironmentId): void {
  markShellSnapshotLive(environmentId);
}

export function useCachedShellSnapshotMetadata(): Readonly<
  Record<EnvironmentId, { readonly snapshotReceivedAt: string }>
> {
  return useAtomValue(cachedShellSnapshotMetadataAtom);
}

export function useShellSnapshot(environmentId: EnvironmentId | null): ShellSnapshotState {
  const targetKey = getShellSnapshotTargetKey({ environmentId });
  const state = useAtomValue(
    targetKey !== null ? shellSnapshotStateAtom(targetKey) : EMPTY_SHELL_SNAPSHOT_ATOM,
  );
  return targetKey === null ? EMPTY_SHELL_SNAPSHOT_STATE : state;
}

export function useShellSnapshotStates(
  environmentIds: ReadonlyArray<EnvironmentId>,
): Readonly<Record<EnvironmentId, ShellSnapshotState>> {
  const stableEnvironmentIds = useMemo(
    () => Arr.sort(new Set(environmentIds), Order.String),
    [environmentIds],
  );
  const snapshotCacheRef = useRef<Readonly<Record<EnvironmentId, ShellSnapshotState>>>({});

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
    const next: Record<EnvironmentId, ShellSnapshotState> = {};

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
