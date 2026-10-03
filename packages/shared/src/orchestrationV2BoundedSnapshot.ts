import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

/** Local timeline rows also carry their item in `projection.turnItems`. */
function isLocalTimelineRow(
  projection: Pick<OrchestrationV2ThreadProjection, "thread">,
  row: OrchestrationV2ProjectedTurnItem,
): boolean {
  return row.visibility === "local" || row.sourceThreadId === projection.thread.id;
}

/**
 * Server half of the opt-in compact bounded snapshot. Bounded `turnItems` start
 * with the items of the window's local visible rows, so those entries can be
 * dropped and rebuilt by `restoreLocalVisibleTurnItems`. Returns null when the
 * projection does not have that exact shape, or when nothing would be omitted;
 * callers then send the unchanged projection without a marker.
 */
export function omitLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection | null {
  let omitted = 0;
  for (const row of projection.visibleTurnItems) {
    if (!isLocalTimelineRow(projection, row)) continue;
    // Same object, not merely the same id: restoring from the row must
    // reproduce the original entry exactly.
    if (projection.turnItems[omitted] !== row.item) return null;
    omitted += 1;
  }
  if (omitted === 0) return null;
  return { ...projection, turnItems: projection.turnItems.slice(omitted) };
}

/**
 * Client half: call on a decoded snapshot that carries the
 * `turnItemsOmitLocalVisible` marker, before reducers or caches see it.
 */
export function restoreLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const local = projection.visibleTurnItems
    .filter((row) => isLocalTimelineRow(projection, row))
    .map((row) => row.item);
  if (local.length === 0) return projection;
  return { ...projection, turnItems: [...local, ...projection.turnItems] };
}

/** The usable projection of a decoded bounded snapshot, compact or not. */
export function boundedSnapshotProjection(snapshot: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly turnItemsOmitLocalVisible?: true | undefined;
}): OrchestrationV2ThreadProjection {
  return snapshot.turnItemsOmitLocalVisible === true
    ? restoreLocalVisibleTurnItems(snapshot.projection)
    : snapshot.projection;
}
