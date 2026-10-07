import {
  EnvironmentId,
  PluginActionId,
  ProjectId,
  ThreadId,
  type PluginAction,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildPluginActionPaletteItems,
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

describe("buildPluginActionPaletteItems", () => {
  const thread = {
    environmentId: EnvironmentId.make("environment-1"),
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
  };
  const deploy: PluginAction = {
    id: PluginActionId.make("installation-1:1:deploy"),
    pluginId: "acme.deploy",
    pluginName: "Deploy",
    name: "deploy",
    title: "Deploy this branch",
    target: "thread",
    placements: ["command-palette"],
  };

  it("runs an offered action in the open thread's environment", () => {
    const runAction = vi.fn();
    const offered = buildPluginActionPaletteItems({
      actions: [deploy],
      canOperate: true,
      thread,
      runAction,
    });
    expect(offered.map((item) => item.title)).toEqual(["Deploy this branch"]);

    offered[0]?.run();

    expect(runAction).toHaveBeenCalledWith({
      environmentId: thread.environmentId,
      action: deploy,
      target: { _tag: "thread", threadId: thread.id },
    });
  });

  it("offers nothing to a connection that cannot operate the environment", () => {
    expect(
      buildPluginActionPaletteItems({
        actions: [deploy],
        canOperate: false,
        thread,
        runAction: vi.fn(),
      }),
    ).toEqual([]);
  });
});
