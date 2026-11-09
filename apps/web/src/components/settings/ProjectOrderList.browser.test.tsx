import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectOrderList } from "./ProjectOrderList";

const state = vi.hoisted(() => ({
  groups: [] as SidebarProjectSnapshot[],
  updateClientSettings: vi.fn(async () => {}),
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  updateClientSettings: state.updateClientSettings,
}));

vi.mock(import("../../hooks/useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: () => state.groups,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: () => ({ selectScope: vi.fn() }) as never,
}));
vi.mock(import("../ProjectFavicon"), () => ({ ProjectFavicon: () => <span /> }));

function group(name: string, memberKeys: readonly string[], pinned = false) {
  return {
    projectKey: name,
    displayName: name,
    workspaceRoot: `/code/${name}`,
    pinned,
    archived: false,
    memberProjects: memberKeys.map((physicalProjectKey) => ({ physicalProjectKey })),
  } as unknown as SidebarProjectSnapshot;
}

function setup(groups: SidebarProjectSnapshot[]) {
  state.groups = groups;
  state.updateClientSettings.mockClear();
  useUiStateStore.setState({ projectOrder: [] });
}

async function moveDown(name: string) {
  const handle = page.getByRole("button", { name: new RegExp(`^Reorder ${name},`) });
  await expect.element(handle).toBeVisible();
  handle.element().focus();
  await userEvent.keyboard(" ");
  await expect.element(handle).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard(" ");
  await expect.element(handle).not.toHaveAttribute("aria-pressed", "true");
}

describe("ProjectOrderList", () => {
  it("saves a dragged project's checkouts together and locks the order", async () => {
    setup([group("alpha", ["a-local", "a-remote"]), group("beta", ["b"]), group("gamma", ["g"])]);
    await using _screen = await render(<ProjectOrderList />);

    await moveDown("alpha");

    expect(useUiStateStore.getState().projectOrder).toEqual(["b", "a-local", "a-remote", "g"]);
    expect(state.updateClientSettings).toHaveBeenCalledWith({ sidebarProjectSortOrder: "manual" });
  });

  it("leaves the order alone when a drop crosses the pinned line", async () => {
    setup([group("pinned", ["p"], true), group("beta", ["b"])]);
    await using _screen = await render(<ProjectOrderList />);

    await moveDown("pinned");

    expect(useUiStateStore.getState().projectOrder).toEqual([]);
    expect(state.updateClientSettings).not.toHaveBeenCalled();
  });
});
