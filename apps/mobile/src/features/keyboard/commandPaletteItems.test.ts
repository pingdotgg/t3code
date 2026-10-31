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
  type CommandPaletteItem,
} from "./commandPaletteItems";

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
describe("buildPluginActionPaletteItems", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const thread = {
    environmentId,
    threadId: ThreadId.make("thread-1"),
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
  const refresh: PluginAction = {
    ...deploy,
    id: PluginActionId.make("installation-1:1:refresh"),
    name: "refresh",
    title: "Refresh caches",
    target: "environment",
  };

  it("runs an offered action in the open thread's environment", () => {
    const runAction = vi.fn();
    const offered = buildPluginActionPaletteItems({
      actions: [deploy],
      canOperate: true,
      ...thread,
      runAction,
    });
    expect(offered.map((item) => item.title)).toEqual(["Deploy this branch"]);

    offered[0]?.run();

    expect(runAction).toHaveBeenCalledWith({
      environmentId: thread.environmentId,
      action: deploy,
      target: { _tag: "thread", threadId: thread.threadId },
    });
  });

  it("offers environment actions when no thread is open", () => {
    const runAction = vi.fn();
    const offered = buildPluginActionPaletteItems({
      actions: [deploy, refresh],
      canOperate: true,
      environmentId,
      threadId: null,
      projectId: null,
      runAction,
    });
    expect(offered.map((item) => item.title)).toEqual(["Refresh caches"]);

    offered[0]?.run();

    expect(runAction).toHaveBeenCalledWith({
      environmentId,
      action: refresh,
      target: { _tag: "environment" },
    });
  });

  it("offers nothing to a connection that cannot operate the environment", () => {
    expect(
      buildPluginActionPaletteItems({
        actions: [deploy],
        canOperate: false,
        ...thread,
        runAction: vi.fn(),
      }),
    ).toEqual([]);
  });
});
