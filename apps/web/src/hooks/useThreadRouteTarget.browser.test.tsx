import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../test/render";
import { startMainAppLocationTracking } from "../components/sidebar/mainAppLocation";
import { useShownThreadRouteTarget } from "./useThreadRouteTarget";

function ShownThread() {
  const { shownTarget } = useShownThreadRouteTarget();
  const label =
    shownTarget === null
      ? "none"
      : shownTarget.kind === "server"
        ? shownTarget.threadRef.threadId
        : shownTarget.draftId;
  return (
    <>
      <output>{label}</output>
      <Outlet />
    </>
  );
}

function createAppRouter(initialPath: string) {
  const rootRoute = createRootRoute({ component: ShownThread });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$environmentId/$threadId",
  });
  const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "settings" });
  const settingsGeneralRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "general",
  });
  const usageRoute = createRoute({ getParentRoute: () => rootRoute, path: "usage" });
  const newRoute = createRoute({ getParentRoute: () => rootRoute, path: "new" });
  return createRouter({
    routeTree: rootRoute.addChildren([
      threadRoute,
      settingsRoute.addChildren([settingsGeneralRoute]),
      usageRoute,
      newRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe("useShownThreadRouteTarget", () => {
  it("keeps the thread that opened Settings or Usage shown until the user leaves for another page", async () => {
    const router = createAppRouter("/env-1/thread-a");
    await router.load();
    // The hook reads thread params and modal paths from real routes, which the default router lacks.
    await using screen = await render(<RouterProvider router={router} />, { router: false });
    const shown = screen.getByRole("status");
    await expect.element(shown).toHaveTextContent("thread-a");

    await act(() => router.navigate({ to: "/settings/general" }));
    await expect.element(shown).toHaveTextContent("thread-a");

    await act(() => router.navigate({ to: "/usage" }));
    await expect.element(shown).toHaveTextContent("thread-a");

    await act(() => router.navigate({ href: "/env-1/thread-b" }));
    await expect.element(shown).toHaveTextContent("thread-b");

    await act(() => router.navigate({ to: "/new" }));
    await expect.element(shown).toHaveTextContent("none");

    await act(() => router.navigate({ to: "/settings/general" }));
    await expect.element(shown).toHaveTextContent("none");
  });

  it("shows the thread behind Settings when it mounts while Settings is already open", async () => {
    const router = createAppRouter("/env-1/thread-a");
    await router.load();
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    await router.navigate({ to: "/settings/general" });

    // The hook reads thread params and modal paths from real routes, which the default router lacks.
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    await expect.element(screen.getByRole("status")).toHaveTextContent("thread-a");
  });
});
