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

/**
 * Keeps the workspace file queries (file contents, entries listing) in sync
 * with turn checkpoints. Their atoms cache indefinitely while subscribed, so
 * without this an agent's edits stay invisible until an app restart. Each
 * completed turn already ships a checkpoint with the changed-file list; a
 * query refetches when any checkpoint it has not yet reconciled against
 * touched it. No polling, no watchers.
 *
 * Known gaps: a revert to before the thread's first checkpoint leaves nothing
 * to compare against and is not detected, and turns run by a different thread
 * sharing this cwd only reconcile when that thread becomes focused. The
 * manual refresh button covers both.
 */

/** One checkpoint reduced to what staleness detection needs. All statuses
 * are scanned: interrupted and failed turns carry real changed-file lists,
 * while mid-turn placeholders ship empty ones and scan as no-ops. */
interface ScannedCheckpoint {
  readonly completedAt: string;
  readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
}

/** The thread's checkpoint history reduced to what staleness detection needs. */
export interface CheckpointsSnapshot {
  /** Highest turn count across all checkpoints, mid-turn placeholders
   * included. A drop means turns were reverted away, even when the newest
   * captured checkpoint survived the revert. */
  readonly maxTurnCount: number;
  /** Latest capture time across all checkpoints; "" until one exists. */
  readonly latestCompletedAt: string;
  readonly checkpoints: ReadonlyArray<ScannedCheckpoint>;
}

/** The snapshot values a query scope was last reconciled against. */
export interface ScopeMarker {
  readonly completedAt: string;
  readonly maxTurnCount: number;
}

export type ScopeAction = "none" | "refresh";

/**
 * Decide whether one cached workspace query must refetch, and the marker to
 * record either way.
 *
 * A cold marker asks for a refresh: a query fetched before this scope
 * existed has unprovable freshness. The caller's in-flight-first-fetch guard
 * turns that into a no-op when the query is fetching fresh anyway.
 *
 * Forward staleness compares capture times, not turn counts or checkpoint
 * refs. Capture times move forward even when a revert-then-redo recreates a
 * checkpoint under the same turn count and ref name, and comparing against
 * every checkpoint newer than the marker covers scopes that were inactive
 * across several turns. This assumes server capture times are monotonic per
 * thread. A drop in maxTurnCount is a revert; the removed checkpoints'
 * contents are unknowable, so always refetch.
 */
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

/**
 * Checkpoint diff paths are repo-root-relative while viewer paths are
 * cwd-relative; when the project cwd sits below the repo root they differ by
 * a directory prefix, so fall back to a suffix match. A false positive costs
 * one extra read; a false negative leaves exactly the stale view this module
 * exists to fix.
 */
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

// The thread reducer clones checkpoint entries on every streamed assistant
// message, so subscribing to the raw checkpoints atom re-renders per chunk.
// This memo returns the previous snapshot object while its contents are
// unchanged, so subscribers only render when checkpoints actually move.
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

/** Null while the thread has no checkpoints (non-git workspace, or detail
 * still loading); consumers hold their markers until it reappears. */
export function useCheckpointsSnapshot(threadRef: ScopedThreadRef): CheckpointsSnapshot | null {
  return useAtomValue(checkpointsSnapshotAtomFamily(threadKey(threadRef)));
}

// Module-level so a scope remembers across remounts. The query atoms this
// guards outlive their components on an idle TTL, so the markers must
// outlive them too. Both reset together on page load. Scope keys must
// include the thread: turn counts and capture times only order within one
// thread, and threads can share a cwd.
const reconciledScopes = new Map<string, ScopeMarker>();

/**
 * Refetch one cached workspace query when checkpoints prove it stale. Pass a
 * null `scopeKey` while the consumer is hidden; the scope then re-reconciles
 * on its next mount against every checkpoint it missed. Settled results,
 * including failed reads, always refetch, since a turn may have just created
 * the file whose read failed. A checkpoint that lands while the query's
 * first fetch is in flight defers instead: that read may predate the turn's
 * writes, so the marker stays unreconciled and the settled result (an effect
 * dependency) re-evaluates it.
 */
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
    // A cold marker's first fetch starts in the same render that read this
    // snapshot, so it is fresh for it; a warm settled value may not be.
    if (firstFetchInFlight) return;
    appAtomRegistry.refresh(queryAtom);
  }, [scopeKey, snapshot, result, queryAtom]);
}
