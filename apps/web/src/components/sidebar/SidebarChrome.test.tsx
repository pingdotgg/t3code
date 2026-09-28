import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [], isReady: true }),
}));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdatePill: () => null,
  SidebarUpdateArchitectureWarning: () => null,
}));
vi.mock("../ui/sidebar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/sidebar")>()),
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

import { SidebarBackButton, SidebarUtilityMenu } from "./SidebarChrome";
import { MainAppLocationTracker } from "./mainAppLocation";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

// Mirrors the Settings sidebar: Back above the sections, the footer menu without it.
function SettingsSidebar() {
  return (
    <>
      <ul data-testid="top">
        <SidebarBackButton />
      </ul>
      <SidebarUtilityMenu hideBack />
    </>
  );
}

async function renderAt(path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <MainAppLocationTracker />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/threads/$id", component: () => null }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings/general",
        component: SettingsSidebar,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  await act(() => {
    renderer = create(<RouterProvider router={router} />);
  });
  return router;
}

const buttonsLabelled = (label: string) =>
  renderer!.root.findAll(
    (node) =>
      node.type === "button" &&
      node.findAll((child) => child.children.includes(label)).length > 0,
  );

describe("settings sidebar Back", () => {
  it("shows a single Back above the sections and returns to the last main app page", async () => {
    // The tracker remembers the thread the user left to open Settings.
    await renderAt("/threads/abc");
    await act(() => renderer?.unmount());
    const router = await renderAt("/settings/general");

    const backButtons = buttonsLabelled("Back");
    expect(backButtons).toHaveLength(1);
    expect(renderer!.root.findByProps({ "data-testid": "top" }).findAllByType("button")).toEqual(
      backButtons,
    );

    await act(async () => {
      backButtons[0]!.props.onClick();
      await router.load();
    });
    expect(router.state.location.pathname).toBe("/threads/abc");
  });
});
