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
      selectedEnvironmentIds: new Set(),
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

  it("keeps multiple selected environments checked", () => {
    const menu = buildHomeListFilterMenu({
      environments: [
        { environmentId: "environment-1" as never, label: "Primary" },
        { environmentId: "environment-2" as never, label: "Remote" },
        { environmentId: "environment-3" as never, label: "Other" },
      ],
      projects: [],
      selectedEnvironmentIds: new Set(["environment-1" as never, "environment-2" as never]),
      selectedProjectKey: null,
      projectSortOrder: "updated_at",
      threadSortOrder: "updated_at",
      onEnvironmentChange: vi.fn(),
      onProjectChange: vi.fn(),
      onProjectSortOrderChange: vi.fn(),
      onThreadSortOrderChange: vi.fn(),
    });

    expect(menu.items[0]).toMatchObject({
      type: "submenu",
      items: [
        { title: "All environments", state: "off" },
        { title: "Primary", state: "on" },
        { title: "Remote", state: "on" },
        { title: "Other", state: "off" },
      ],
    });
  });
});
