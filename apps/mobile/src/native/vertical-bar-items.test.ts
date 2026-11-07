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
const filter: HeaderItem = {
  type: "item",
  id: "filter",
  menu: { id: "filter:menu", type: "menu", title: "Model filters", children: [] },
};
const search: HeaderItem = { type: "item", id: "search", searchBarPlacement: true };

describe("fitting a column's items into the Duo vertical bar", () => {
  it("folds the actions into More and keeps the search field when they do not fit", () => {
    const items = fitVerticalBarItems(
      [files, git, filter, { type: "spacer", id: "group", sizing: "fixed", width: 8 }, search],
      () => false,
    );
    expect(items.map((item) => item.id)).toEqual(["vertical-bar-more", "search"]);
    const more = items[0]!;
    expect(more.type === "item" && "menu" in more ? more.menu?.children : []).toEqual([
      expect.objectContaining({ id: "files:more", title: "Files", disabled: false }),
      expect.objectContaining({ id: "git:menu", title: "Git" }),
      expect.objectContaining({ id: "filter:menu", title: "Model filters" }),
    ]);
  });

  it("leaves the search field out of the bar's length", () => {
    const sizes: (readonly number[])[] = [];
    fitVerticalBarItems(
      [files, git, { type: "spacer", id: "group", sizing: "fixed", width: 8 }, search],
      (groupSizes) => {
        sizes.push(groupSizes);
        return true;
      },
    );
    expect(sizes).toEqual([[2, 0]]);
  });

  it("does not fold a single action into a menu", () => {
    const items = [files, search];
    expect(fitVerticalBarItems(items, () => false)).toBe(items);
  });
});

describe("a folded Duo thread's vertical bar", () => {
  const terminal: HeaderItem = { ...git, id: "terminal", title: "Terminal" };
  // The folded pose reported by the iOS 27.1 Duo simulator. The bar's top occlusion is 174pt at
  // rest and 264pt with a Live Activity; on device it was about 255pt.
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
  // A collapsed split still lists the thread first in its detail routes.
  const threadBar = (metrics: NativeLayoutMetrics) =>
    fitColumnVerticalBarItems(metrics, 4, {
      backButtonVisible: true,
      detailRoot: true,
      leading: [],
      trailing: [terminal, git, files],
      compose: false,
      keyboardVisible: false,
    }).map((item) => item.id);

  it("keeps the thread actions while the outer camera is at rest", () => {
    expect(threadBar(folded(174))).toEqual(["terminal", "git", "files"]);
  });

  it("counts the Back button above the actions when a Live Activity grows the camera", () => {
    expect(threadBar(folded(224))).toEqual(["vertical-bar-more"]);
    expect(threadBar(folded(255))).toEqual(["vertical-bar-more"]);
    expect(threadBar(folded(264))).toEqual(["vertical-bar-more"]);
  });
});

describe("an unfolded Duo's detail column", () => {
  const terminal: HeaderItem = { ...git, id: "terminal", title: "Terminal" };
  const landscape: NativeLayoutMetrics = {
    width: 951,
    height: 669,
    hasHinge: true,
    horizontalSizeClass: "regular",
    verticalBarEdge: "right",
    safeArea: { top: 0, bottom: 34, left: 0, right: 84 },
    reservedRegions: [{ kind: "occlusion", x: 867, y: 0, width: 84, height: 174 }],
    bottomBarInset: 24,
  };
  const detailBar = (detailRoot: boolean) =>
    fitColumnVerticalBarItems(landscape, 4, {
      backButtonVisible: true,
      detailRoot,
      leading: [],
      trailing: [
        files,
        { type: "spacer", id: "group", sizing: "fixed", width: 8 },
        terminal,
        git,
        filter,
      ],
      compose: false,
      keyboardVisible: false,
    }).map((item) => item.id);

  it("leaves Back out of the first screen, which starts the column's own stack", () => {
    expect(detailBar(true)).toEqual(["files", "group", "terminal", "git", "filter"]);
  });

  it("counts Back on a screen pushed over the first one", () => {
    expect(detailBar(false)).toEqual(["vertical-bar-more"]);
  });
});
