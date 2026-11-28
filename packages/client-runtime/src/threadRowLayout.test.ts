import { describe, expect, it } from "vite-plus/test";

import {
  MOBILE_DEFAULT_STORED_LAYOUT,
  resolveSidebarRowLayout,
  resolveSidebarRowLines,
  storedSidebarRowLayout,
} from "./threadRowLayout.ts";

const ids = (tokens: ReadonlyArray<{ id: string }> | null) => tokens?.map((token) => token.id);

describe("thread row lines", () => {
  const layout = resolveSidebarRowLayout({
    top: ["projectIcon", "projectName", "spacer"],
    middle: ["title"],
    bottom: ["branch", "spacer", "agents"],
  });
  const resolve = (hasBranch: boolean, keepLines: ReadonlyArray<"middle" | "bottom"> = []) =>
    resolveSidebarRowLines({
      lines: layout,
      titleLine: "middle",
      keepLines,
      hasContent: (token) => token.id === "title" || (token.id === "branch" && hasBranch),
    });

  it("folds a line with only agents and spacers, and moves its agents to the title's line", () => {
    const lines = resolve(false);
    expect(lines.bottom).toBeNull();
    expect(ids(lines.middle)).toEqual(["title", "agents"]);
    expect(ids(resolve(true).bottom)?.slice(0, 3)).toEqual(["branch", "spacer", "agents"]);
  });

  it("keeps a kept line with items, but never one with nothing on it", () => {
    expect(resolve(false, ["bottom"]).bottom).not.toBeNull();
    const empty = resolveSidebarRowLines({
      lines: { ...layout, bottom: [] },
      titleLine: "middle",
      keepLines: ["bottom"],
      hasContent: () => true,
    });
    expect(empty.bottom).toBeNull();
  });
});

describe("mobile thread row defaults", () => {
  it("saves an unchanged mobile layout as empty, so later default changes reach it", () => {
    const layout = resolveSidebarRowLayout({}, MOBILE_DEFAULT_STORED_LAYOUT);
    expect(ids(layout.top)).toEqual(["projectIcon", "title", "time"]);
    expect(storedSidebarRowLayout(layout, MOBILE_DEFAULT_STORED_LAYOUT)).toEqual({});
  });
});
