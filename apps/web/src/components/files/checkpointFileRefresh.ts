import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type {
  OrchestrationCheckpointFile,
  OrchestrationCheckpointSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadDetails } from "~/state/threads";


interface ScannedCheckpoint {
  readonly completedAt: string;
  readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
}

export interface CheckpointsSnapshot {
  readonly maxTurnCount: number;
  readonly latestCompletedAt: string;
  readonly checkpoints: ReadonlyArray<ScannedCheckpoint>;
}

export interface ScopeMarker {
  readonly completedAt: string;
  readonly maxTurnCount: number;
}

export type ScopeAction = "none" | "refresh";

export function evaluateScopeRefresh(
  marker: ScopeMarker | undefined,
  snapshot: CheckpointsSnapshot,
  isRelevant: (files: ReadonlyArray<OrchestrationCheckpointFile>) => boolean,
): { readonly marker: ScopeMarker; readonly action: ScopeAction } {
  const nextMarker: ScopeMarker = {
    completedAt: snapshot.latestCompletedAt,
    maxTurnCount: snapshot.maxTurnCount,
  };
  if (marker === undefined) {
    return { marker: nextMarker, action: "refresh" };
  }
  if (snapshot.maxTurnCount < marker.maxTurnCount) {
    return { marker: nextMarker, action: "refresh" };
  }
  const relevant = snapshot.checkpoints.some(
    (checkpoint) => checkpoint.completedAt > marker.completedAt && isRelevant(checkpoint.files),
  );
  return { marker: nextMarker, action: relevant ? "refresh" : "none" };
}

export function checkpointFilesIncludePath(
  files: ReadonlyArray<OrchestrationCheckpointFile>,
  relativePath: string,
): boolean {
  const suffix = `/${relativePath}`;
  return files.some((file) => file.path === relativePath || file.path.endsWith(suffix));
}

export function buildSnapshot(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): CheckpointsSnapshot | null {
  if (checkpoints.length === 0) return null;
  let maxTurnCount = 0;
  let latestCompletedAt = "";
  const scanned: Array<ScannedCheckpoint> = [];
  for (const checkpoint of checkpoints) {
    if (checkpoint.checkpointTurnCount > maxTurnCount) {
      maxTurnCount = checkpoint.checkpointTurnCount;
    }
    scanned.push({ completedAt: checkpoint.completedAt, files: checkpoint.files });
    if (checkpoint.completedAt > latestCompletedAt) {
      latestCompletedAt = checkpoint.completedAt;
    }
  }
  return { maxTurnCount, latestCompletedAt, checkpoints: scanned };
}

function snapshotsEqual(a: CheckpointsSnapshot, b: CheckpointsSnapshot): boolean {
  return (
    a.maxTurnCount === b.maxTurnCount &&
    a.latestCompletedAt === b.latestCompletedAt &&
    a.checkpoints.length === b.checkpoints.length &&
    a.checkpoints.every(
      (entry, index) =>
        entry.completedAt === b.checkpoints[index]?.completedAt &&
        entry.files === b.checkpoints[index]?.files,
    )
  );
}

const SNAPSHOT_IDLE_TTL_MS = 5 * 60_000;

const checkpointsSnapshotAtomFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  let previous: CheckpointsSnapshot | null = null;
  return Atom.make((get): CheckpointsSnapshot | null => {
    const next = buildSnapshot(get(environmentThreadDetails.checkpointsAtom(ref)));
    if (previous !== null && next !== null && snapshotsEqual(previous, next)) {
      return previous;
    }
    previous = next;
    return next;
  }).pipe(Atom.setIdleTTL(SNAPSHOT_IDLE_TTL_MS), Atom.withLabel(`checkpoints-snapshot:${key}`));
});

export function useCheckpointsSnapshot(threadRef: ScopedThreadRef): CheckpointsSnapshot | null {
  return useAtomValue(checkpointsSnapshotAtomFamily(threadKey(threadRef)));
}

const reconciledScopes = new Map<string, ScopeMarker>();

export function useCheckpointQueryRefresh<A, E>(
  scopeKey: string | null,
  snapshot: CheckpointsSnapshot | null,
  isRelevant: (files: ReadonlyArray<OrchestrationCheckpointFile>) => boolean,
  queryAtom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): void {
  const currentIsRelevant = useRef(isRelevant);
  currentIsRelevant.current = isRelevant;
  const result = useAtomValue(queryAtom);

  useEffect(() => {
    if (scopeKey === null || snapshot === null) return;
    const marker = reconciledScopes.get(scopeKey);
    const decision = evaluateScopeRefresh(marker, snapshot, currentIsRelevant.current);
    const firstFetchInFlight = result.waiting && Option.isNone(AsyncResult.value(result));
    if (decision.action === "refresh" && marker !== undefined && firstFetchInFlight) {
      return;
    }
    reconciledScopes.set(scopeKey, decision.marker);
    if (decision.action === "none") return;
    if (firstFetchInFlight) return;
    appAtomRegistry.refresh(queryAtom);
  }, [scopeKey, snapshot, result, queryAtom]);
}
