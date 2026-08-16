import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

function findRegistryNode(atom: Parameters<typeof appAtomRegistry.get>[0]) {
  const nodes = appAtomRegistry.getNodes();
  const direct = nodes.get(atom);
  if (direct) {
    return direct;
  }
  for (const node of nodes.values()) {
    if (node.atom === atom) {
      return node;
    }
  }
  return undefined;
}

/**
 * Peek an already-fetched archived snapshot. Returns null when the snapshot
 * has never been loaded so new-thread does not pull the full archive list.
 */
export function readArchivedThreadExists(ref: ScopedThreadRef): boolean | null {
  const atom = archivedSnapshotAtom(ref.environmentId);
  const node = findRegistryNode(atom);
  if (node === undefined || node.currentState() !== "valid") {
    return null;
  }
  const snapshot = Option.getOrNull(
    AsyncResult.value(
      node.value() as AsyncResult.AsyncResult<OrchestrationShellSnapshot, unknown>,
    ),
  );
  if (snapshot === null) {
    return null;
  }
  return snapshot.threads.some((thread) => thread.id === ref.threadId);
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  }, [environmentIds]);

  return {
    ...result,
    refresh,
  };
}
