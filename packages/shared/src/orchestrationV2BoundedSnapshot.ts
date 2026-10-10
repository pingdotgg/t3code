import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  TurnItemId,
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

type CheckpointFiles = OrchestrationV2ThreadProjection["checkpoints"][number]["files"];

function sameCheckpointFiles(left: CheckpointFiles, right: CheckpointFiles): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.path !== b.path ||
      a.kind !== b.kind ||
      a.additions !== b.additions ||
      a.deletions !== b.deletions ||
      Object.keys(a).length !== Object.keys(b).length
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Server half of the opt-in checkpoint compaction. A checkpoint turn item
 * repeats its checkpoint's file list, which can hold thousands of entries.
 * Items whose files equal those of their checkpoint in `projection.checkpoints`
 * are sent with empty `files`; the returned ids tell the client which ones to
 * refill with `restoreCheckpointItemFiles`. Returns null when nothing would be
 * omitted.
 */
export function omitCheckpointItemFiles(projection: OrchestrationV2ThreadProjection): {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly itemIds: ReadonlyArray<TurnItemId>;
} | null {
  const checkpointFiles = new Map<string, CheckpointFiles>();
  for (const checkpoint of projection.checkpoints) {
    if (checkpoint.files.length > 0) checkpointFiles.set(String(checkpoint.id), checkpoint.files);
  }
  if (checkpointFiles.size === 0) return null;
  const itemIds = new Set<TurnItemId>();
  const compact = (item: OrchestrationV2TurnItem): OrchestrationV2TurnItem => {
    if (item.type !== "checkpoint" || item.files.length === 0) return item;
    const files = checkpointFiles.get(String(item.checkpointId));
    if (files === undefined || !sameCheckpointFiles(files, item.files)) return item;
    itemIds.add(item.id);
    return { ...item, files: [] };
  };
  const turnItems = projection.turnItems.map(compact);
  const visibleTurnItems = projection.visibleTurnItems.map((row) => {
    const item = compact(row.item);
    return item === row.item ? row : { ...row, item };
  });
  if (itemIds.size === 0) return null;
  return {
    projection: { ...projection, turnItems, visibleTurnItems },
    itemIds: [...itemIds],
  };
}

/** Client half of `omitCheckpointItemFiles`, before reducers or caches see the projection. */
function restoreCheckpointItemFiles(
  projection: OrchestrationV2ThreadProjection,
  itemIds: ReadonlyArray<TurnItemId>,
): OrchestrationV2ThreadProjection {
  if (itemIds.length === 0) return projection;
  const omitted = new Set(itemIds.map(String));
  const checkpointFiles = new Map(
    projection.checkpoints.map((checkpoint) => [String(checkpoint.id), checkpoint.files]),
  );
  const restore = (item: OrchestrationV2TurnItem): OrchestrationV2TurnItem => {
    if (item.type !== "checkpoint" || !omitted.has(String(item.id))) return item;
    const files = checkpointFiles.get(String(item.checkpointId));
    return files === undefined ? item : { ...item, files };
  };
  return {
    ...projection,
    turnItems: projection.turnItems.map(restore),
    visibleTurnItems: projection.visibleTurnItems.map((row) => {
      const item = restore(row.item);
      return item === row.item ? row : { ...row, item };
    }),
  };
}

/** The usable projection of a decoded bounded snapshot, compact or not. */
export function boundedSnapshotProjection(snapshot: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly turnItemsOmitLocalVisible?: true | undefined;
  readonly checkpointFilesOmittedItemIds?: ReadonlyArray<TurnItemId> | undefined;
}): OrchestrationV2ThreadProjection {
  // Files first: restoring local items copies the visible rows' items.
  const projection =
    snapshot.checkpointFilesOmittedItemIds === undefined
      ? snapshot.projection
      : restoreCheckpointItemFiles(snapshot.projection, snapshot.checkpointFilesOmittedItemIds);
  return snapshot.turnItemsOmitLocalVisible === true
    ? restoreLocalVisibleTurnItems(projection)
    : projection;
}
