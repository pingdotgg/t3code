import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface, ThreadRightPanelState } from "../rightPanelStore";
import { createDefaultDockTree, insertGroupBeside } from "./dockLayout";
import type { DockLayout } from "./dockLayoutStore";
import { resolveDockView } from "./dockView";

const terminal = (id: string, groupId?: string): RightPanelSurface => ({
  id: `terminal:${id}`,
  kind: "terminal",
  resourceId: id,
  terminalIds: [id],
  activeTerminalId: id,
  ...(groupId === undefined ? {} : { groupId }),
});
const diff: RightPanelSurface = { id: "diff", kind: "diff" };

const layout: DockLayout = {
  root: insertGroupBeside(createDefaultDockTree(), "chat", "bottom", "bottom", 200),
  kindGroups: { terminal: "bottom" },
};
const thread = (overrides: Partial<ThreadRightPanelState>): ThreadRightPanelState => ({
  isOpen: true,
  activeSurfaceId: null,
  surfaces: [],
  ...overrides,
});
const view = (input: Partial<Parameters<typeof resolveDockView>[0]>) =>
  resolveDockView({ layout, thread: null, threadsSide: "left", ...input });

describe("resolveDockView", () => {
  it("drops groups with nothing to show, so a thread without a terminal keeps the room", () => {
    expect([...view({}).groups.keys()]).toEqual(["chat"]);
    expect([...view({ thread: thread({ surfaces: [terminal("a")] }) }).groups.keys()]).toEqual([
      "chat",
      "bottom",
    ]);
  });

  it("routes tabs by pin, then kind, then the default panel", () => {
    const groups = view({
      thread: thread({ surfaces: [terminal("a"), terminal("b", "panel"), diff] }),
    }).groups;
    expect(groups.get("bottom")?.surfaces.map((surface) => surface.id)).toEqual(["terminal:a"]);
    expect(groups.get("panel")?.surfaces.map((surface) => surface.id)).toEqual([
      "terminal:b",
      "diff",
    ]);
  });

  it("falls back to the kind when a pinned group no longer exists", () => {
    const groups = view({ thread: thread({ surfaces: [terminal("a", "gone")] }) }).groups;
    expect(groups.get("bottom")?.surfaces).toHaveLength(1);
  });

  it("never puts a tab in the chat's group, even if one was left there", () => {
    const groups = view({ thread: thread({ surfaces: [terminal("a", "chat")] }) }).groups;
    expect(groups.get("chat")?.surfaces).toEqual([]);
    expect(groups.get("bottom")?.surfaces).toHaveLength(1);
  });

  it("leaves a hidden group and a closed panel out", () => {
    const surfaces = [terminal("a"), diff];
    expect(
      view({ thread: thread({ surfaces, hiddenGroupIds: ["bottom"] }) }).groups.has("bottom"),
    ).toBe(false);
    expect(view({ thread: thread({ surfaces, isOpen: false }) }).groups.has("panel")).toBe(false);
  });

  it("shows a group's recorded tab, or its newest without one", () => {
    const surfaces = [diff, terminal("a", "panel")];
    expect(view({ thread: thread({ surfaces }) }).groups.get("panel")?.activeSurface?.id).toBe(
      "terminal:a",
    );
    expect(
      view({ thread: thread({ surfaces, activeGroupTabs: { panel: "diff" } }) }).groups.get("panel")
        ?.activeSurface?.id,
    ).toBe("diff");
  });

  it("shows the launcher in the default panel for an open thread with no surfaces", () => {
    expect(view({ thread: thread({}) }).groups.get("panel")?.launcher).toBe(true);
  });

  it("maximizes the group of the focused surface", () => {
    const surfaces = [terminal("a")];
    expect(
      view({
        thread: thread({ surfaces, activeSurfaceId: "terminal:a", maximized: true }),
      }).maximizedGroupId,
    ).toBe("bottom");
  });

  it("gives a maximized group the title bar corners, since it covers the whole dock", () => {
    const maximized = thread({
      surfaces: [terminal("a")],
      activeSurfaceId: "terminal:a",
      maximized: true,
    });
    expect(view({ thread: maximized, threadsSide: "left" }).edges).toMatchObject({
      left: null,
      right: "bottom",
    });
    expect(view({ thread: maximized, threadsSide: "right" }).edges).toMatchObject({
      left: "bottom",
      right: null,
    });
    expect(view({ thread: maximized, threadsSide: null }).edges.top.has("bottom")).toBe(true);
  });

  it("gives up the title bar corner the threads sidebar occupies", () => {
    expect(view({ threadsSide: "left" }).edges).toMatchObject({ left: null, right: "chat" });
    expect(view({ threadsSide: "right" }).edges).toMatchObject({ left: "chat", right: null });
    expect(view({ threadsSide: null }).edges).toMatchObject({ left: "chat", right: "chat" });
  });
});
