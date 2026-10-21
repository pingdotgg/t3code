export interface SpaceColumnBounds {
  readonly spaceId: string | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type Bounds = Omit<SpaceColumnBounds, "spaceId">;

/** Translate premeasured window bounds by scrolling since the drag began. */
export function spaceProjectDropTarget(
  columns: ReadonlyArray<SpaceColumnBounds>,
  viewport: Bounds,
  x: number,
  y: number,
  scrollDeltaX = 0,
): string | null | undefined {
  const contains = (bounds: Bounds) =>
    x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height;
  if (!contains(viewport)) return undefined;
  return columns.find((column) => contains({ ...column, x: column.x - scrollDeltaX }))?.spaceId;
}
