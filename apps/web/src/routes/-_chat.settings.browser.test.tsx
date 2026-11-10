import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { Route } from "./_chat.settings";

vi.mock("../components/AppRouteModal", () => ({
  AppRouteModal: ({ children }: { children: ReactNode }) => children,
  AppRouteModalClose: () => null,
}));
vi.mock("../components/settings/SettingsSidebarNav", () => ({
  SettingsSidebarNav: () => null,
}));
vi.mock("../components/settings/SettingsBreadcrumb", () => ({
  SettingsBreadcrumb: ({ pathname }: { pathname: string }) => <h1>{pathname}</h1>,
}));
vi.mock("../components/settings/SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => null,
  SettingsScopeProvider: ({ children }: { children: ReactNode }) => children,
  useSettingsScope: () => ({
    scope: { kind: "all" },
    search: {},
    connectedEnvironments: [],
  }),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("../components/settings/SettingsPanels", () => ({
  RestoreDeviceDefaultsButton: () => null,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("keeps the breadcrumb with the rendered page while the next route loads", async () => {
  const root = createRootRoute({ component: Outlet });
  const chat = createRoute({ getParentRoute: () => root, id: "_chat", component: Outlet });
  const settings = createRoute({
    getParentRoute: () => chat,
    path: "settings",
    component: Route.options.component!,
  });
  const pending = deferred();
  const loading = deferred();
  const general = createRoute({
    getParentRoute: () => settings,
    path: "general",
    component: () => <p>General body</p>,
  });
  const appearance = createRoute({
    getParentRoute: () => settings,
    path: "appearance",
    loader: () => {
      loading.resolve();
      return pending.promise;
    },
    component: () => <p>Appearance body</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([settings.addChildren([general, appearance])])]),
    history: createMemoryHistory({ initialEntries: ["/settings/general"] }),
    defaultPendingMs: Infinity,
  });
  await router.load();
  await using screen = await render(<RouterProvider router={router} />);
  await expect.element(screen.getByText("General body")).toBeVisible();

  const navigation = router.navigate({ to: "/settings/appearance" });
  try {
    await act(() => loading.promise);
    await expect.element(screen.getByRole("heading")).toHaveTextContent("/settings/general");
    await expect.element(screen.getByText("General body")).toBeVisible();
  } finally {
    pending.resolve();
    await act(() => navigation);
  }

  await expect.element(screen.getByRole("heading")).toHaveTextContent("/settings/appearance");
  await expect.element(screen.getByText("Appearance body")).toBeVisible();
});
