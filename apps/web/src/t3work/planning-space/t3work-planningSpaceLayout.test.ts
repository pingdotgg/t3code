import { describe, expect, it } from "vite-plus/test";

import {
  ALL_TILE_MIN_WIDTH,
  type EpicTile,
  type LayoutStory,
  UNASSIGNED_OWNER_KEY,
  layoutAllGrid,
  layoutByEpic,
  layoutByOwner,
  layoutBySprint,
} from "./t3work-planningSpaceLayout";
import {
  FRAME_WIDTH_BUDGET,
  type PackedFrame,
} from "./t3work-planningSpaceScene";

/** Mirrors a real sprint's verified shape: 21 epics, clusters of 1–8, subtasks 0–6. */
function realisticStories(): LayoutStory[] {
  const stories: LayoutStory[] = [];
  const owners = [
    "AM", "GW", "CW", "UE", "PJ", "AH", "AZ", "MA", "CR", "BM",
    "SB", "ML", "ME", "MJ", "MG", "DB", "AS", "YP",
  ];
  const clusterSizes = [8, 5, 4, 3, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  let storyIndex = 0;
  clusterSizes.forEach((size, epicIndex) => {
    for (let i = 0; i < size; i++) {
      stories.push({
        id: `S${storyIndex}`,
        epicId: `E${epicIndex}`,
        ownerId: storyIndex % 5 === 0 ? null : (owners[storyIndex % owners.length] ?? null),
        inSprint: storyIndex % 3 !== 0,
        subtaskCount: [0, 3, 6, 1, 5, 2][storyIndex % 6] ?? 0,
      });
      storyIndex++;
    }
  });
  return stories;
}

function expectFramesDisjoint(frames: ReadonlyArray<PackedFrame>) {
  const half = FRAME_WIDTH_BUDGET / 2;
  for (let a = 0; a < frames.length; a++) {
    for (let b = a + 1; b < frames.length; b++) {
      const fa = frames[a];
      const fb = frames[b];
      if (!fa || !fb) throw new Error("missing frame");
      const overlaps =
        fa.centerX - half < fb.centerX + half &&
        fb.centerX - half < fa.centerX + half &&
        fa.centerY - fa.height / 2 < fb.centerY + fb.height / 2 &&
        fb.centerY - fb.height / 2 < fa.centerY + fa.height / 2;
      expect(overlaps, `${fa.id} overlaps ${fb.id}`).toBe(false);
    }
  }
}

describe("layoutByEpic", () => {
  const stories = realisticStories();
  const epicOrder = [...new Set(stories.map((s) => s.epicId))];

  it("positions every story without any frame overlap (clusters 1–8)", () => {
    const layout = layoutByEpic(stories, epicOrder);
    expect(layout.frames.size).toBe(stories.length);
    expectFramesDisjoint([...layout.frames.values()]);
  });

  it("keeps every story below its epic anchor and inside the cluster columns", () => {
    const layout = layoutByEpic(stories, epicOrder);
    for (const story of stories) {
      const frame = layout.frames.get(story.id);
      const anchor = layout.anchors.get(story.epicId);
      expect(frame).toBeDefined();
      expect(anchor).toBeDefined();
      if (!frame || !anchor) continue;
      expect(frame.centerY - frame.height / 2).toBeGreaterThanOrEqual(anchor.y);
      expect(Math.abs(frame.centerX - anchor.x)).toBeLessThanOrEqual(240);
    }
  });

  it("is deterministic", () => {
    const first = layoutByEpic(stories, epicOrder);
    const second = layoutByEpic(stories, epicOrder);
    expect([...second.frames.entries()]).toEqual([...first.frames.entries()]);
  });
});

describe("layoutBySprint", () => {
  const stories = realisticStories();

  it("separates sprint and outside stories into disjoint zones", () => {
    const layout = layoutBySprint(stories);
    expectFramesDisjoint([...layout.frames.values()]);
    const sprintZone = layout.zones.get("sprint");
    const outsideZone = layout.zones.get("outside");
    expect(sprintZone).toBeDefined();
    expect(outsideZone).toBeDefined();
    for (const story of stories) {
      const frame = layout.frames.get(story.id);
      if (!frame) throw new Error("missing frame");
      if (story.inSprint) expect(frame.centerX).toBeLessThan(0);
      else expect(frame.centerX).toBeGreaterThan(0);
    }
  });

  it("sizes each zone to contain all of its stories", () => {
    const layout = layoutBySprint(stories);
    for (const [key, zone] of layout.zones) {
      const members = stories.filter((s) =>
        key === "sprint" ? s.inSprint : !s.inSprint,
      );
      for (const story of members) {
        const frame = layout.frames.get(story.id);
        if (!frame) throw new Error("missing frame");
        expect(frame.centerY + frame.height / 2).toBeLessThanOrEqual(
          zone.top + zone.height,
        );
        expect(Math.abs(frame.centerX - zone.centerX)).toBeLessThanOrEqual(
          zone.width / 2,
        );
      }
    }
  });
});

describe("layoutByOwner", () => {
  const stories = realisticStories();
  const owners = [...new Set(stories.map((s) => s.ownerId).filter(Boolean))] as string[];

  it("groups stories under their owner anchor, unassigned in its own cluster", () => {
    const layout = layoutByOwner(stories, owners);
    expectFramesDisjoint([...layout.frames.values()]);
    for (const story of stories) {
      const frame = layout.frames.get(story.id);
      const anchor = layout.anchors.get(story.ownerId ?? UNASSIGNED_OWNER_KEY);
      expect(frame).toBeDefined();
      expect(anchor).toBeDefined();
      if (!frame || !anchor) continue;
      expect(Math.abs(frame.centerX - anchor.x)).toBeLessThanOrEqual(240);
    }
  });

  it("handles 18 owners (rows of 4) without anchor collisions", () => {
    const layout = layoutByOwner(stories, owners);
    const seen = new Set<string>();
    for (const [, anchor] of layout.anchors) {
      const key = `${anchor.x}:${anchor.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("layoutAllGrid", () => {
  const viewport = { width: 1280, height: 760 };

  function expectTilesDisjointAndInside(tiles: EpicTile[]) {
    for (const tile of tiles) {
      expect(tile.left).toBeGreaterThanOrEqual(0);
      expect(tile.top).toBeGreaterThanOrEqual(0);
      expect(tile.left + tile.width).toBeLessThanOrEqual(viewport.width);
      expect(tile.top + tile.height).toBeLessThanOrEqual(viewport.height);
    }
    for (let a = 0; a < tiles.length; a++) {
      for (let b = a + 1; b < tiles.length; b++) {
        const ta = tiles[a];
        const tb = tiles[b];
        if (!ta || !tb) throw new Error("missing tile");
        const overlaps =
          ta.left < tb.left + tb.width &&
          tb.left < ta.left + ta.width &&
          ta.top < tb.top + tb.height &&
          tb.top < ta.top + ta.height;
        expect(overlaps).toBe(false);
      }
    }
  }

  it("fits 21 epics fully readable inside the viewport", () => {
    const tiles = layoutAllGrid(
      Array.from({ length: 21 }, (_, i) => `E${i}`),
      viewport,
    );
    expect(tiles).toHaveLength(21);
    expectTilesDisjointAndInside(tiles);
    for (const tile of tiles) {
      expect(tile.width).toBeGreaterThanOrEqual(ALL_TILE_MIN_WIDTH);
    }
  });

  it("shrinks but never below the readable minimum for large epic counts", () => {
    const tiles = layoutAllGrid(
      Array.from({ length: 60 }, (_, i) => `E${i}`),
      viewport,
    );
    expect(tiles).toHaveLength(60);
    for (const tile of tiles) {
      expect(tile.width).toBeGreaterThanOrEqual(ALL_TILE_MIN_WIDTH);
    }
  });

  it("returns an empty grid for no epics", () => {
    expect(layoutAllGrid([], viewport)).toEqual([]);
  });
});
