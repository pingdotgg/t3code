import { describe, expect, it } from "vite-plus/test";
import type { NativeLayoutMetrics } from "../lib/reserved-regions";
import {
  fitColumnVerticalBarItems,
  fitVerticalBarItems,
  type HeaderItem,
} from "./vertical-bar-items";

const files: HeaderItem = { type: "item", id: "files", title: "Files", onPress: () => {} };
const git: HeaderItem = {
  type: "item",
  id: "git",
  title: "Git",
  menu: { id: "git:menu", type: "menu", children: [] },
};
const terminal: HeaderItem = {
  type: "item",
  id: "terminal",
  title: "Terminal",
  menu: { id: "terminal:menu", type: "menu", children: [] },
};
const search: HeaderItem = { type: "item", id: "search", searchBarPlacement: true };

describe("fitting a column's items into the Duo vertical bar", () => {
  it("folds the actions into More, keeps their labels and leaves the search field out", () => {
    const sizes: (readonly number[])[] = [];
    const items = fitVerticalBarItems(
      [files, git, { type: "spacer", id: "group", sizing: "fixed", width: 8 }, search],
      (groupSizes) => {
        sizes.push(groupSizes);
        return false;
      },
    );
    expect(sizes).toEqual([[2, 0]]);
    expect(items.map((item) => item.id)).toEqual(["vertical-bar-more", "search"]);
    const more = items[0]!;
    expect(more.type === "item" && "menu" in more ? more.menu?.children : []).toEqual([
      expect.objectContaining({ id: "files:more", title: "Files", disabled: false }),
      expect.objectContaining({ id: "git:menu", title: "Git" }),
    ]);
  });

  it("does not fold a single action into a menu", () => {
    const items = [files, search];
    expect(fitVerticalBarItems(items, () => false)).toBe(items);
  });
});

describe("a folded Duo thread's vertical bar", () => {
  // The folded pose reported by the iOS 27.1 Duo simulator. The bar's top occlusion is 174pt at
  // rest and 264pt with a Live Activity.
  const folded = (cameraHeight: number): NativeLayoutMetrics => ({
    width: 466,
    height: 678,
    hasHinge: true,
    horizontalSizeClass: "compact",
    verticalBarEdge: "right",
    safeArea: { top: 0, bottom: 34, left: 0, right: 84 },
    reservedRegions: [{ kind: "occlusion", x: 382, y: 0, width: 84, height: cameraHeight }],
    bottomBarInset: 24,
  });
  const threadBar = (metrics: NativeLayoutMetrics) =>
    fitColumnVerticalBarItems(metrics, 4, {
      backButtonVisible: true,
      leading: [],
      trailing: [terminal, git, files],
      compose: false,
      keyboardVisible: false,
    }).map((item) => item.id);

  it("keeps the thread actions while the outer camera is at rest", () => {
    expect(threadBar(folded(174))).toEqual(["terminal", "git", "files"]);
  });

  it("counts the Back button above the actions when a Live Activity grows the camera", () => {
    expect(threadBar(folded(264))).toEqual(["vertical-bar-more"]);
  });
});
