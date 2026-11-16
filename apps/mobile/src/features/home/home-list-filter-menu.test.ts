import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import {
  buildHomeListFilterMenu,
  buildHomeListFilterMenuItems,
  homeListFilterEnvironments,
} from "./home-list-filter-menu";

describe("buildHomeListFilterMenu", () => {
  it("adds a project scope submenu that selects and clears the same scope as the chips", () => {
    const onProjectChange = vi.fn();
    const menu = buildHomeListFilterMenu({
      environments: [],
      projects: [
        { key: "environment-1:project-1", label: "Codething" },
        { key: "environment-1:project-2", label: "Website" },
      ],
      selectedEnvironmentId: null,
      selectedProjectKey: "environment-1:project-1",
      onEnvironmentChange: vi.fn(),
      onProjectChange,
    });

    const projectMenu = menu.items.find(
      (item) => item.type === "submenu" && item.title === "Project",
    );
    expect(menu.items.some((item) => item.title === "Settings")).toBe(false);
    expect(projectMenu).toMatchObject({
      type: "submenu",
      items: [
        { title: "All projects", state: "off" },
        { title: "Codething", state: "on" },
        { title: "Website", state: "off" },
      ],
    });
    if (projectMenu?.type !== "submenu") throw new Error("Expected project submenu");

    projectMenu.items[0]?.onPress();
    projectMenu.items[2]?.onPress();
    expect(onProjectChange).toHaveBeenNthCalledWith(1, null);
    expect(onProjectChange).toHaveBeenNthCalledWith(2, "environment-1:project-2");
  });

  it("offers the Orbit profile's workspaces first, only when there are any", () => {
    const onWorkspaceChange = vi.fn();
    const base = {
      environments: [],
      projects: [],
      selectedEnvironmentId: null,
      selectedProjectKey: null,
      onEnvironmentChange: vi.fn(),
      onProjectChange: vi.fn(),
    };
    expect(buildHomeListFilterMenu(base).items.some((item) => item.title === "Workspace")).toBe(
      false,
    );

    const menu = buildHomeListFilterMenu({
      ...base,
      workspaces: [
        { id: "ws-1", label: "Orbit" },
        { id: "ws-2", label: "Apps" },
      ],
      selectedWorkspaceId: "ws-2",
      onWorkspaceChange,
    });
    const workspaceMenu = menu.items[0];
    expect(workspaceMenu).toMatchObject({
      type: "submenu",
      title: "Workspace",
      items: [
        { title: "All projects", state: "off" },
        { title: "Orbit", state: "off" },
        { title: "Apps", state: "on" },
      ],
    });
    if (workspaceMenu?.type !== "submenu") throw new Error("Expected workspace submenu");
    workspaceMenu.items[1]?.onPress();
    workspaceMenu.items[0]?.onPress();
    expect(onWorkspaceChange).toHaveBeenNthCalledWith(1, "ws-1");
    expect(onWorkspaceChange).toHaveBeenNthCalledWith(2, null);
  });
});

it("selects and clears a workspace through the native list header menu", () => {
  const onWorkspaceChange = vi.fn();
  const menu = buildHomeListFilterMenuItems({
    environments: [],
    projects: [],
    selectedEnvironmentId: null,
    selectedProjectKey: null,
    onEnvironmentChange: vi.fn(),
    onProjectChange: vi.fn(),
    workspaces: [{ id: "apps", label: "Apps" }],
    selectedWorkspaceId: "apps",
    onWorkspaceChange,
  });
  const workspace = menu.find((item) => item.id === "workspace");
  expect(workspace).toMatchObject({
    title: "Workspace",
    items: [
      { title: "All projects", selected: false },
      { title: "Apps", selected: true },
    ],
  });
  if (!workspace || !("items" in workspace)) throw new Error("Missing workspace menu");
  for (const item of workspace.items ?? []) {
    if ("onPress" in item) item.onPress?.();
  }
  expect(onWorkspaceChange.mock.calls).toEqual([[null], ["apps"]]);
});

function environment(
  environmentId: string,
  environmentLabel: string,
  isEnabled: boolean,
): WorkspaceEnvironment {
  return {
    environmentId: environmentId as EnvironmentId,
    environmentLabel,
    displayUrl: "",
    isRelayManaged: false,
    isEnabled,
    connectionState: isEnabled ? "connected" : "available",
    connectionError: null,
    connectionErrorTraceId: null,
  };
}

it("offers only switched-on environments, sorted by label", () => {
  expect(
    homeListFilterEnvironments([
      environment("env-studio", "Studio", true),
      environment("env-laptop", "Laptop", false),
      environment("env-desk", "Desk", true),
    ]),
  ).toEqual([
    { environmentId: "env-desk", label: "Desk", connectionState: "connected" },
    { environmentId: "env-studio", label: "Studio", connectionState: "connected" },
  ]);
});
