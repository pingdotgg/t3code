/**
 * All-band epic tile grid (§3.2): epics ONLY, as a dense screen-space tile grid
 * at a fixed, fully readable size — tile content does not scale with camera
 * depth. Split out of t3work-planningSpaceLayout.ts.
 */

import type { Viewport } from "./t3work-planningSpaceScene";

export const ALL_TILE_WIDTH = 220;
export const ALL_TILE_HEIGHT = 124;
export const ALL_TILE_GAP = 14;
export const ALL_TILE_MIN_WIDTH = 176;

export interface EpicTile {
  readonly epicId: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function layoutAllGrid(
  epicIds: ReadonlyArray<string>,
  viewport: Viewport,
  reservedTop: number = 48,
  reservedBottom: number = 72,
): EpicTile[] {
  const usableWidth = viewport.width - ALL_TILE_GAP * 2;
  const usableHeight = viewport.height - reservedTop - reservedBottom - ALL_TILE_GAP;
  const count = epicIds.length;
  if (count === 0) return [];
  let tileWidth = ALL_TILE_WIDTH;
  let tileHeight = ALL_TILE_HEIGHT;
  let columns = Math.max(1, Math.floor(usableWidth / (tileWidth + ALL_TILE_GAP)));
  let rows = Math.ceil(count / columns);
  if (rows * (tileHeight + ALL_TILE_GAP) > usableHeight) {
    const shrink = Math.max(
      ALL_TILE_MIN_WIDTH / ALL_TILE_WIDTH,
      Math.sqrt(usableHeight / (rows * (tileHeight + ALL_TILE_GAP))),
    );
    tileWidth = Math.max(ALL_TILE_MIN_WIDTH, Math.floor(tileWidth * shrink));
    tileHeight = Math.floor(tileHeight * (tileWidth / ALL_TILE_WIDTH));
    columns = Math.max(1, Math.floor(usableWidth / (tileWidth + ALL_TILE_GAP)));
    rows = Math.ceil(count / columns);
  }
  const gridWidth = columns * (tileWidth + ALL_TILE_GAP) - ALL_TILE_GAP;
  const gridHeight = rows * (tileHeight + ALL_TILE_GAP) - ALL_TILE_GAP;
  const originX = (viewport.width - gridWidth) / 2;
  const originY = Math.max(reservedTop, reservedTop + (usableHeight - gridHeight) / 2);
  return epicIds.map((epicId, index) => ({
    epicId,
    left: originX + (index % columns) * (tileWidth + ALL_TILE_GAP),
    top: originY + Math.floor(index / columns) * (tileHeight + ALL_TILE_GAP),
    width: tileWidth,
    height: tileHeight,
  }));
}
