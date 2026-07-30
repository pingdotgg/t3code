import type { OrchestrationV2ThreadProjection, TurnItemId } from "@t3tools/contracts";

export function resolveThreadImagePath(
  projection: Pick<OrchestrationV2ThreadProjection, "turnItems">,
  turnItemId: TurnItemId,
): string | null {
  const item = projection.turnItems.find(
    (candidate) =>
      candidate.id === turnItemId &&
      candidate.type === "image_view" &&
      candidate.status === "completed",
  );
  return item?.type === "image_view" ? item.path : null;
}
