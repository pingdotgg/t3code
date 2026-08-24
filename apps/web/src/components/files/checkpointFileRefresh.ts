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

const INACTIVE_QUERY_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("checkpoint-query-refresh:inactive"),
);

export function checkpointRefreshQueryAtom<A, E>(
  scopeKey: string | null,
  queryAtom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Atom.Atom<AsyncResult.AsyncResult<A, E>> {
  return scopeKey === null ? INACTIVE_QUERY_ATOM : queryAtom;
}

export interface ScopeReconciliationState {
  readonly marker: ScopeMarker | undefined;
  readonly reconciledSnapshot: CheckpointsSnapshot | undefined;
  readonly initialFetchSnapshot: CheckpointsSnapshot | null | undefined;
}

export const MAX_RECONCILED_SCOPES = 256;

export function createScopeReconciliationCache() {
  const states = new Map<string, ScopeReconciliationState>();

  return {
    get(scopeKey: string) {
      const state = states.get(scopeKey);
      if (state === undefined) return undefined;
      states.delete(scopeKey);
      states.set(scopeKey, state);
      return state;
    },
    set(scopeKey: string, state: ScopeReconciliationState) {
      states.delete(scopeKey);
      states.set(scopeKey, state);
      while (states.size > MAX_RECONCILED_SCOPES) {
        const oldestScopeKey = states.keys().next().value;
        if (oldestScopeKey === undefined) break;
        states.delete(oldestScopeKey);
      }
    },
    size() {
      return states.size;
    },
  };
}

function changedCheckpointIsRelevant(
  previous: CheckpointsSnapshot,
  next: CheckpointsSnapshot,
  isRelevant: (files: ReadonlyArray<OrchestrationCheckpointFile>) => boolean,
): boolean {
  // The snapshot atom preserves file-array references across streamed clones.
  // A changed reference at the same cursor is a placeholder being replaced.
  return next.checkpoints.some(
    (checkpoint, index) =>
      checkpoint.files !== previous.checkpoints[index]?.files && isRelevant(checkpoint.files),
  );
}

export function evaluateScopeRefresh(
  marker: ScopeMarker | undefined,
  snapshot: CheckpointsSnapshot,
  isRelevant: (files: ReadonlyArray<OrchestrationCheckpointFile>) => boolean,
  reconciledSnapshot?: CheckpointsSnapshot,
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
  const replacementIsRelevant =
    reconciledSnapshot !== undefined &&
    changedCheckpointIsRelevant(reconciledSnapshot, snapshot, isRelevant);
  return { marker: nextMarker, action: relevant || replacementIsRelevant ? "refresh" : "none" };
}

export function reconcileScopeRefresh(
  state: ScopeReconciliationState | undefined,
  snapshot: CheckpointsSnapshot | null,
  firstFetchInFlight: boolean,
  isRelevant: (files: ReadonlyArray<OrchestrationCheckpointFile>) => boolean,
): { readonly state: ScopeReconciliationState; readonly action: ScopeAction } {
  const currentState =
    state ??
    ({
      marker: undefined,
      reconciledSnapshot: undefined,
      initialFetchSnapshot: firstFetchInFlight ? snapshot : undefined,
    } satisfies ScopeReconciliationState);

  if (snapshot === null) {
    return { state: currentState, action: "none" };
  }

  const decision = evaluateScopeRefresh(
    currentState.marker,
    snapshot,
    isRelevant,
    currentState.reconciledSnapshot,
  );
  const initialFetchCoversSnapshot =
    firstFetchInFlight &&
    currentState.marker === undefined &&
    currentState.initialFetchSnapshot === snapshot;
  if (firstFetchInFlight && decision.action === "refresh" && !initialFetchCoversSnapshot) {
    return { state: currentState, action: "none" };
  }

  return {
    state: {
      marker: decision.marker,
      reconciledSnapshot: snapshot,
      initialFetchSnapshot: undefined,
    },
    action: firstFetchInFlight ? "none" : decision.action,
  };
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

const reconciledScopes = createScopeReconciliationCache();

export function useCheckpointQueryRefresh<A, E>(
  scopeKey: string | null,
  snapshot: CheckpointsSnapshot | null,
  isRelevant: (files: ReadonlyArray<OrchestrationCheckpointFile>) => boolean,
  queryAtom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): void {
  const currentIsRelevant = useRef(isRelevant);
  currentIsRelevant.current = isRelevant;
  const result = useAtomValue(checkpointRefreshQueryAtom(scopeKey, queryAtom));

  useEffect(() => {
    if (scopeKey === null) return;
    const firstFetchInFlight = result.waiting && Option.isNone(AsyncResult.value(result));
    const decision = reconcileScopeRefresh(
      reconciledScopes.get(scopeKey),
      snapshot,
      firstFetchInFlight,
      currentIsRelevant.current,
    );
    reconciledScopes.set(scopeKey, decision.state);
    if (decision.action === "none") return;
    appAtomRegistry.refresh(queryAtom);
  }, [scopeKey, snapshot, result, queryAtom]);
}
