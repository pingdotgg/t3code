import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import {
  scopeThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
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

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

export interface ArchivedThreadDeletionContext {
  readonly thread: EnvironmentThreadShell;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectCwd: string | null;
}

export function resolveArchivedThreadDeletionContext(
  snapshot: OrchestrationShellSnapshot,
  ref: ScopedThreadRef,
): ArchivedThreadDeletionContext | null {
  const thread = snapshot.threads.find((candidate) => candidate.id === ref.threadId);
  if (!thread) {
    return null;
  }

  return {
    thread: scopeThreadShell(ref.environmentId, thread),
    threads: snapshot.threads.map((candidate) => scopeThreadShell(ref.environmentId, candidate)),
    projectCwd:
      snapshot.projects.find((candidate) => candidate.id === thread.projectId)?.workspaceRoot ??
      null,
  };
}

export function readArchivedThreadDeletionContext(
  ref: ScopedThreadRef,
): ArchivedThreadDeletionContext | null {
  const result = appAtomRegistry.get(archivedSnapshotAtom(ref.environmentId));
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  return snapshot ? resolveArchivedThreadDeletionContext(snapshot, ref) : null;
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
