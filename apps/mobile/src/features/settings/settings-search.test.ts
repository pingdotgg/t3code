import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_SEARCH_ITEMS, searchSettings } from "./settings-search";

const titles = (query: string) =>
  searchSettings(query, SETTINGS_SEARCH_ITEMS).map((item) => item.title);

describe("searchSettings", () => {
  it("returns nothing for a blank query", () => {
    expect(searchSettings("   ", SETTINGS_SEARCH_ITEMS)).toEqual([]);
  });

  it("finds individual settings by keyword, not just section names", () => {
    expect(titles("dark mode")).toEqual(["Color scheme"]);
    expect(titles("airpods")).toEqual(["Preferred microphone order"]);
    expect(titles("ocean")).toEqual(["Themes"]);
  });

  it("ranks title matches above keyword and section matches", () => {
    const results = titles("worktree");
    expect(results.slice(0, 2)).toEqual(["Worktree submodules", "Worktree branch naming"]);
    expect(results).toContain("Default workspace");
  });

  it("matches every word across title, section, and keywords", () => {
    expect(titles("source control prefix")).toEqual(["Worktree branch naming"]);
    expect(titles("source control nonexistent")).toEqual([]);
  });

  it("puts an exact title first", () => {
    expect(titles("usage")[0]).toBe("Usage");
  });
});
