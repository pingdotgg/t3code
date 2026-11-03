import "../index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import type { SortingStrategy } from "@dnd-kit/sortable";
import { createSidebarSortingStrategy, measureSidebarPinnedGrid } from "./Sidebar.drag";
import { sidebarListItemId, type SidebarListItem } from "./Sidebar.logic";
import { createSidebarListMotion } from "./Sidebar.motion";

function mountPinnedGrid(width: number, count: number) {
  const list = document.createElement("ul");
  list.style.cssText = `display:flex;flex-direction:column;gap:1px;width:${width}px;position:relative`;
  const header = document.createElement("li");
  header.style.cssText = "height:0;margin-inline:0.125rem";
  const grid = document.createElement("ul");
  grid.className = "sidebar-pinned-grid";
  grid.dataset.sidebarMotionGroup = "";
  const tiles = Array.from({ length: count }, () => grid.appendChild(document.createElement("li")));
  list.append(header, grid);
  document.body.append(list);
  return { list, header, grid, tiles, [Symbol.dispose]: () => list.remove() };
}

describe("pinned grid layout contract", () => {
  it("does not animate tiles from their old columns after the sidebar resizes", () => {
    using mounted = mountPinnedGrid(244, 5);
    const motion = createSidebarListMotion(mounted.list);
    try {
      motion.update(false);
      mounted.list.style.width = "200px";
      motion.update(true);
      expect(mounted.tiles.flatMap((tile) => tile.getAnimations())).toHaveLength(0);
    } finally {
      motion.dispose();
    }
  });

  // Pinning remounts a card as a tile; it should travel from the card, not appear from nowhere.
  it.each(["menu", "drop"] as const)("lands a %s pin where its card was", async (path) => {
    using mounted = mountPinnedGrid(244, 2);
    const card = document.createElement("li");
    card.dataset.threadItem = "t";
    card.textContent = "Thread identity";
    card.style.height = "82px";
    mounted.list.append(card);
    const motion = createSidebarListMotion(mounted.list);
    try {
      motion.update(false);
      const from = card.getBoundingClientRect();
      if (path === "drop") motion.release();
      card.remove();
      const tile = mounted.grid.appendChild(document.createElement("li"));
      tile.dataset.threadItem = "t";
      tile.textContent = "Thread identity";
      motion.update(true);
      expect(mounted.list.textContent).toBe("Thread identity");
      const animations = tile.getAnimations();
      expect(animations).toHaveLength(1);
      animations[0]!.pause();
      const start = tile.getBoundingClientRect();
      expect(start.left + start.width / 2).toBeCloseTo(from.left + from.width / 2, 0);
      expect(start.top + start.height / 2).toBeCloseTo(from.top + from.height / 2, 0);
      // Menu pinning and dropping both hold hover details until the row lands.
      const settling = () => mounted.list.hasAttribute("data-sidebar-settling");
      expect(settling()).toBe(true);
      for (const animation of mounted.list.getAnimations({ subtree: true })) animation.finish();
      await vi.waitFor(() => expect(settling()).toBe(false));
    } finally {
      motion.dispose();
    }
  });

  it.each([
    [152, 1],
    [200, 2],
    [244, 3],
  ])("projects a still drag onto the CSS grid at %ipx (%i columns)", (width, columns) => {
    for (let count = 1; count <= 5; count++) {
      using mounted = mountPinnedGrid(width, count);
      const pinnedGrid = measureSidebarPinnedGrid(mounted.grid, 1);
      expect(pinnedGrid?.columns).toBe(columns);
      const items: SidebarListItem[] = [
        { kind: "marker", marker: "pinned-header" },
        ...mounted.tiles.map((_, index) => ({
          kind: "thread" as const,
          key: `p${index}`,
          section: "pinned" as const,
        })),
        { kind: "marker", marker: "pinned-divider" },
      ];
      const rects = [mounted.header, ...mounted.tiles, mounted.header].map((node) =>
        node.getBoundingClientRect(),
      );
      const strategy = createSidebarSortingStrategy({
        items,
        settledOrder: [],
        settledExpanded: true,
        pinnedGrid,
      });
      const activeIndex = count;
      const args = {
        activeIndex,
        overIndex: activeIndex,
        activeNodeRect: rects[activeIndex]!,
        rects,
        index: 0,
      } satisfies Parameters<SortingStrategy>[0];
      for (const [index, item] of items.entries()) {
        if (item.kind !== "thread") continue;
        const transform = strategy({ ...args, index });
        const tile = `${sidebarListItemId(item)} of ${count}`;
        expect(transform?.x, tile).toBeCloseTo(0, 1);
        expect(transform?.y, tile).toBeCloseTo(0, 1);
        expect(transform?.scaleX, tile).toBeCloseTo(1, 3);
      }
    }
  });
});
