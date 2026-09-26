import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  pathname: "/",
  electron: true,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Outlet: () => null,
}));
vi.mock("../env", () => ({
  get isElectron() {
    return state.electron;
  },
}));
vi.mock("../browser/ElectronBrowserHost", () => ({
  ElectronBrowserHost: () => <div data-test-browser-host="" />,
}));
vi.mock("../components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("../components/AppSidebarLayout", () => ({
  AppSidebarLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/CommandPalette", () => ({
  CommandPalette: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/WebSocketConnectionSurface", () => ({
  WebSocketConnectionCoordinator: () => null,
  SlowRpcAckToastCoordinator: () => null,
  WebSocketConnectionSurface: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/ui/toast", () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
  AnchoredToastProvider: ({ children }: { children: ReactNode }) => children,
}));

import { Route } from "../routes/__root";

describe("root browser ownership", () => {
  beforeEach(() => {
    state.pathname = "/";
    state.electron = true;
    vi.spyOn(Route, "useRouteContext").mockImplementation(() => ({
      queryClient: new QueryClient(),
      authGateState: { status: "authenticated" },
    }));
  });

  async function renderRoot() {
    const Root = Route.options.component;
    if (!Root) throw new Error("Root route has no component");
    const routeTree = createRootRoute({ component: Root });
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [state.pathname] }),
    });
    await router.load();
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  it("mounts exactly one native browser host for the authenticated app", async () => {
    expect((await renderRoot()).match(/data-test-browser-host/g)).toHaveLength(1);
  });

  it.each(["/pair", "/connect", "/connect/callback"])(
    "does not mount a native browser host on %s",
    async (pathname) => {
      state.pathname = pathname;
      expect(await renderRoot()).not.toContain("data-test-browser-host");
    },
  );

  it("does not mount a native browser host outside Electron", async () => {
    state.electron = false;
    expect(await renderRoot()).not.toContain("data-test-browser-host");
  });
});
