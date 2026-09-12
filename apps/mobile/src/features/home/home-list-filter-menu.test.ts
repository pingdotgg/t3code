import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenu } from "./home-list-filter-menu";

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
      projectSortOrder: "updated_at",
      threadSortOrder: "updated_at",
      onEnvironmentChange: vi.fn(),
      onProjectChange,
      onProjectSortOrderChange: vi.fn(),
      onThreadSortOrderChange: vi.fn(),
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
});

describe("buildHomeListFilterMenu clear action", () => {
  it("offers a top-level Clear filters action only while a scope is active", () => {
    const onEnvironmentChange = vi.fn();
    const onProjectChange = vi.fn();
    const build = (selectedProjectKey: string | null) =>
      buildHomeListFilterMenu({
        environments: [],
        projects: [{ key: "p", label: "P" }],
        selectedEnvironmentId: null,
        selectedProjectKey,
        projectSortOrder: "updated_at",
        threadSortOrder: "updated_at",
        onEnvironmentChange,
        onProjectChange,
        onProjectSortOrderChange: vi.fn(),
        onThreadSortOrderChange: vi.fn(),
      });

    expect(build(null).items.at(-1)).toMatchObject({ type: "submenu", title: "Sort threads" });
    const group = build("p").items.at(-1);
    expect(group).toMatchObject({
      type: "submenu",
      displayInline: true,
      items: [{ type: "action", title: "Clear filters" }],
    });
    if (group?.type !== "submenu") throw new Error("Expected inline group");
    group.items[0]?.onPress();
    expect(onEnvironmentChange).toHaveBeenCalledWith(null);
    expect(onProjectChange).toHaveBeenCalledWith(null);
  });
});
