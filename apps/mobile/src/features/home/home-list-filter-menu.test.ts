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
    expect(projectMenu.items.some((item) => item.title === "Remove project…")).toBe(false);
    expect(onProjectChange).toHaveBeenNthCalledWith(2, "environment-1:project-2");
  });

  it("offers a destructive remove action only while a project is scoped", () => {
    const onRemoveSelectedProject = vi.fn();
    const build = (selectedProjectKey: string | null) =>
      buildHomeListFilterMenu({
        environments: [],
        projects: [{ key: "environment-1:project-1", label: "Codething" }],
        selectedEnvironmentId: null,
        selectedProjectKey,
        projectSortOrder: "updated_at",
        threadSortOrder: "updated_at",
        onEnvironmentChange: vi.fn(),
        onProjectChange: vi.fn(),
        onProjectSortOrderChange: vi.fn(),
        onThreadSortOrderChange: vi.fn(),
        onRemoveSelectedProject: selectedProjectKey === null ? null : onRemoveSelectedProject,
      }).items.find((item) => item.type === "submenu" && item.title === "Project");

    const unscoped = build(null);
    if (unscoped?.type !== "submenu") throw new Error("Expected project submenu");
    expect(unscoped.items.some((item) => item.title === "Remove project…")).toBe(false);

    const scoped = build("environment-1:project-1");
    if (scoped?.type !== "submenu") throw new Error("Expected project submenu");
    const remove = scoped.items.at(-1);
    expect(remove).toMatchObject({ title: "Remove project…", destructive: true });
    remove?.onPress();
    expect(onRemoveSelectedProject).toHaveBeenCalledTimes(1);
  });
});
