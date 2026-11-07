import { describe, expect, it } from "vite-plus/test";

import { filterCommandPaletteItems, type CommandPaletteItem } from "./commandPaletteItems";

const NOW = Date.UTC(2026, 9, 23);

function item(
  key: string,
  title: string,
  kind: CommandPaletteItem["kind"],
  searchTerms: string[] = [],
): CommandPaletteItem {
  return {
    key,
    title,
    kind,
    searchTerms,
    ...(kind === "thread" ? { threadSearch: { title, activityAt: NOW } } : {}),
    run: () => {},
  };
}

const items = [
  item("new", "New thread in…", "action", ["project", "create"]),
  item("settings", "Open settings", "action", ["preferences"]),
  item("project", "Mobile app", "project", ["/workspaces/mobile", "new thread"]),
  item("siva:one", "Keyboard shortcuts", "thread"),
  item("mac:one", "Mobile app layout", "thread"),
];
const keys = (results: ReadonlyArray<{ readonly key: string }>) =>
  results.map((entry) => entry.key);

describe("filterCommandPaletteItems", () => {
  it("ranks like the web palette, whole words first, with every token required", () => {
    // A thread active today outranks a project that matches as well, but not
    // one whose whole name was typed.
    expect(keys(filterCommandPaletteItems(items, "mobile", [], NOW))).toEqual([
      "mac:one",
      "project",
    ]);
    expect(keys(filterCommandPaletteItems(items, " MOBILE app ", [], NOW))).toEqual([
      "project",
      "mac:one",
    ]);
    expect(keys(filterCommandPaletteItems(items, "keyboard short", [], NOW))).toEqual(["siva:one"]);
  });

  it("lists message matches after the other results, once, except in actions-only mode", () => {
    const results = filterCommandPaletteItems(items, "layout", ["siva:one", "mac:one"], NOW);
    expect(results.map((entry) => [entry.key, entry.fromMessages ?? false])).toEqual([
      ["mac:one", false],
      ["siva:one", true],
    ]);
    expect(filterCommandPaletteItems(items, "> layout", ["siva:one"], NOW)).toEqual([]);
  });
});
