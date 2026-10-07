import { describe, expect, it } from "vite-plus/test";
import {
  matchesThreadSearchFilters,
  parseThreadSearchQuery,
} from "@t3tools/client-runtime/state/threadSearchQuery";

import {
  filterCommandPaletteItems,
  nextPaletteIndex,
  type CommandPaletteItem,
} from "./commandPaletteItems";

function item(
  key: string,
  title: string,
  kind: CommandPaletteItem["kind"],
  searchTerms: string[] = [],
): CommandPaletteItem {
  return { key, title, kind, searchTerms, run: () => {} };
}

const items = [
  item("new", "New thread in…", "action", ["project", "create"]),
  item("settings", "Open settings", "action", ["preferences"]),
  item("project", "Mobile app", "project", ["/workspaces/mobile", "new thread"]),
  item("siva:one", "Keyboard shortcuts", "thread", ["Mobile app", "Siva"]),
  item("mac:one", "Mobile app", "thread", ["Mac"]),
];
const emptyMatches = new Set<string>();

describe("filterCommandPaletteItems", () => {
  it("shows actions and recent threads in their original order when the query is empty", () => {
    expect(filterCommandPaletteItems(items, "", emptyMatches).map((item) => item.key)).toEqual([
      "new",
      "settings",
      "siva:one",
      "mac:one",
    ]);
  });

  it("matches query tokens across titles and metadata and ranks exact titles first", () => {
    expect(
      filterCommandPaletteItems(items, " MOBILE app ", emptyMatches).map((item) => item.key),
    ).toEqual(["project", "mac:one", "siva:one"]);
    expect(
      filterCommandPaletteItems(items, "siva keyboard", emptyMatches).map((item) => item.key),
    ).toEqual(["siva:one"]);
  });

  it("supports the desktop actions-only prefix and action aliases", () => {
    expect(filterCommandPaletteItems(items, ">", emptyMatches).map((item) => item.key)).toEqual([
      "new",
      "settings",
    ]);
    expect(
      filterCommandPaletteItems(items, "> preferences", emptyMatches).map((item) => item.key),
    ).toEqual(["settings"]);
    expect(
      filterCommandPaletteItems(items, "> new thread", emptyMatches).map((item) => item.key),
    ).toEqual(["new"]);
  });

  it("includes server content matches scoped to the correct environment, except in actions-only mode", () => {
    const matches = new Set(["siva:one", "project"]);
    expect(
      filterCommandPaletteItems(items, "message content", matches).map((item) => item.key),
    ).toEqual(["siva:one"]);
    expect(filterCommandPaletteItems(items, "> message content", matches)).toEqual([]);
  });

  it("applies qualifiers before including a server content match", () => {
    const now = new Date("2026-10-07T12:00:00.000Z");
    const context = {
      projectName: () => "Mobile",
      environmentNames: () => ["Local"],
      providerNames: () => ["Codex"],
      status: () => "ready",
      activityAt: (thread: { updatedAt: string }) => thread.updatedAt,
    };
    const candidates = ["2026-10-06T12:00:00.000Z", "2026-09-01T12:00:00.000Z"].map(
      (updatedAt, index) => ({
        ...item(`thread:${index}`, "Unrelated title", "thread"),
        matchesSearch: (query: string) =>
          matchesThreadSearchFilters(
            { updatedAt, branch: null },
            parseThreadSearchQuery(query, { now }).filters,
            context,
            { now },
          ),
      }),
    );
    const matches = new Set(candidates.map((candidate) => candidate.key));
    expect(
      filterCommandPaletteItems(candidates, "since:7d", matches).map((candidate) => candidate.key),
    ).toEqual(["thread:0"]);
    expect(
      filterCommandPaletteItems(candidates, "since:7d message", matches).map(
        (candidate) => candidate.key,
      ),
    ).toEqual(["thread:0"]);
  });
});

describe("nextPaletteIndex", () => {
  it("wraps arrow navigation in both directions and handles empty results", () => {
    expect(nextPaletteIndex(0, -1, 3)).toBe(2);
    expect(nextPaletteIndex(2, 1, 3)).toBe(0);
    expect(nextPaletteIndex(0, 1, 3)).toBe(1);
    expect(nextPaletteIndex(0, -1, 0)).toBe(0);
    expect(nextPaletteIndex(0, 1, 0)).toBe(0);
  });
});
