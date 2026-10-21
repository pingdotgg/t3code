import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

function isLocalTimelineRow(
  projection: Pick<OrchestrationV2ThreadProjection, "thread">,
  row: OrchestrationV2ProjectedTurnItem,
): boolean {
  return row.visibility === "local" || row.sourceThreadId === projection.thread.id;
}

export function omitLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection | null {
  let omitted = 0;
  for (const row of projection.visibleTurnItems) {
    if (!isLocalTimelineRow(projection, row)) continue;
    // Require object identity so row restoration reproduces the exact entry.
    if (projection.turnItems[omitted] !== row.item) return null;
    omitted += 1;
  }
  if (omitted === 0) return null;
  return { ...projection, turnItems: projection.turnItems.slice(omitted) };
}

/** Restore marked snapshots before reducers or caches see them. */
export function restoreLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const local = projection.visibleTurnItems
    .filter((row) => isLocalTimelineRow(projection, row))
    .map((row) => row.item);
  if (local.length === 0) return projection;
  return { ...projection, turnItems: [...local, ...projection.turnItems] };
}

export function boundedSnapshotProjection(snapshot: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly turnItemsOmitLocalVisible?: true | undefined;
}): OrchestrationV2ThreadProjection {
  return snapshot.turnItemsOmitLocalVisible === true
    ? restoreLocalVisibleTurnItems(snapshot.projection)
    : snapshot.projection;
}
