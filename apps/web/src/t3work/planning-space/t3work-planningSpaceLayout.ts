/**
 * Planning space layout — grouping projections (spec §3.4, §4).
 *
 * Pure module: maps story descriptors to world positions for each grouping
 * mode, plus the screen-space All-band epic tile grid (§3.2). Positions are
 * zoom-independent (hard rule, §3.1) and deterministic.
 */

import {
  FRAME_WIDTH_BUDGET,
  type PackedFrame,
  type SceneBounds,
  type Viewport,
  type WorldPoint,
  boundsOfFrames,
  frameHeight,
  packMasonry,
} from "./t3work-planningSpaceScene";

export interface LayoutStory {
  readonly id: string;
  readonly epicId: string;
  readonly ownerId: string | null;
  readonly inSprint: boolean;
  readonly subtaskCount: number;
}

export interface ZoneRect {
  readonly centerX: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface GroupingLayout {
  readonly frames: ReadonlyMap<string, PackedFrame>;
  readonly anchors: ReadonlyMap<string, WorldPoint>;
  readonly zones: ReadonlyMap<string, ZoneRect>;
  readonly bounds: SceneBounds;
}

export const CLUSTER_COLUMN_OFFSETS = [-240, 240] as const;
export const CLUSTER_SPACING_X = 980;
export const CLUSTER_ROW_GAP = 240;
export const CLUSTERS_PER_ROW = 4;
export const EPIC_HEADER_ZONE = 120;
export const OWNER_HEADER_ZONE = 60;

interface Cluster {
  readonly key: string;
  readonly stories: ReadonlyArray<LayoutStory>;
}

/**
 * Lay clusters in rows of `perRow`; each row's vertical extent is the tallest
 * cluster in it (extent-aware packing — fixed grids were rejected after real
 * data showed cluster sizes 1–8, spec §10.3).
 */
function layoutClusters(
  clusters: ReadonlyArray<Cluster>,
  headerZone: number,
): GroupingLayout {
  const frames = new Map<string, PackedFrame>();
  const anchors = new Map<string, WorldPoint>();
  let rowTop = 0;
  for (let start = 0; start < clusters.length; start += CLUSTERS_PER_ROW) {
    const row = clusters.slice(start, start + CLUSTERS_PER_ROW);
    let rowHeight = 0;
    row.forEach((cluster, column) => {
      const anchorX =
        (column - (CLUSTERS_PER_ROW - 1) / 2) * CLUSTER_SPACING_X;
      anchors.set(cluster.key, { x: anchorX, y: rowTop });
      const items = cluster.stories.map((story) => ({
        id: story.id,
        height: frameHeight(story.subtaskCount),
      }));
      const packed = packMasonry(
        items,
        CLUSTER_COLUMN_OFFSETS.map((offset) => anchorX + offset),
        rowTop + headerZone,
      );
      for (const frame of packed.frames) frames.set(frame.id, frame);
      rowHeight = Math.max(rowHeight, headerZone + packed.totalHeight);
    });
    rowTop += rowHeight + CLUSTER_ROW_GAP;
  }
  const allFrames = [...frames.values()];
  return {
    frames,
    anchors,
    zones: new Map(),
    bounds:
      allFrames.length > 0
        ? boundsOfFrames(allFrames)
        : { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  };
}

/** by-epic: clusters follow the affinity-ordered epic list (§4). */
export function layoutByEpic(
  stories: ReadonlyArray<LayoutStory>,
  epicOrder: ReadonlyArray<string>,
): GroupingLayout {
  const clusters: Cluster[] = epicOrder.map((epicId) => ({
    key: epicId,
    stories: stories.filter((s) => s.epicId === epicId),
  }));
  return layoutClusters(clusters, EPIC_HEADER_ZONE);
}

export const SPRINT_ZONE_CENTER_X = 1240;
export const SPRINT_ZONE_COLUMN_OFFSETS = [-490, 0, 490] as const;

/** by-sprint: two zones — in-sprint left, context/outside right (§4). */
export function layoutBySprint(
  stories: ReadonlyArray<LayoutStory>,
): GroupingLayout {
  const frames = new Map<string, PackedFrame>();
  const zones = new Map<string, ZoneRect>();
  const startY = 0;
  for (const [key, centerX, members] of [
    ["sprint", -SPRINT_ZONE_CENTER_X, stories.filter((s) => s.inSprint)],
    ["outside", SPRINT_ZONE_CENTER_X, stories.filter((s) => !s.inSprint)],
  ] as const) {
    const packed = packMasonry(
      members.map((s) => ({ id: s.id, height: frameHeight(s.subtaskCount) })),
      SPRINT_ZONE_COLUMN_OFFSETS.map((offset) => centerX + offset),
      startY,
    );
    for (const frame of packed.frames) frames.set(frame.id, frame);
    zones.set(key, {
      centerX,
      top: startY - 90,
      width:
        SPRINT_ZONE_COLUMN_OFFSETS.length * 490 + FRAME_WIDTH_BUDGET / 2 + 80,
      height: packed.totalHeight + 170,
    });
  }
  const allFrames = [...frames.values()];
  return {
    frames,
    anchors: new Map(),
    zones,
    bounds:
      allFrames.length > 0
        ? boundsOfFrames(allFrames)
        : { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  };
}

export const UNASSIGNED_OWNER_KEY = "__unassigned__";

/** by-owner: one cluster per member + Unassigned, any team size (§4). */
export function layoutByOwner(
  stories: ReadonlyArray<LayoutStory>,
  ownerOrder: ReadonlyArray<string>,
): GroupingLayout {
  const keys = [...ownerOrder, UNASSIGNED_OWNER_KEY];
  const clusters: Cluster[] = keys.map((ownerKey) => ({
    key: ownerKey,
    stories: stories.filter((s) =>
      ownerKey === UNASSIGNED_OWNER_KEY
        ? s.ownerId === null
        : s.ownerId === ownerKey,
    ),
  }));
  return layoutClusters(clusters, OWNER_HEADER_ZONE);
}


export {
  ALL_TILE_GAP,
  ALL_TILE_HEIGHT,
  ALL_TILE_MIN_WIDTH,
  ALL_TILE_WIDTH,
  type EpicTile,
  layoutAllGrid,
} from "./t3work-planningSpaceLayoutAllGrid";
