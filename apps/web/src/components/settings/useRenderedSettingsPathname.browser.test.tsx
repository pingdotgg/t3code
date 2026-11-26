import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { useRenderedSettingsPathname } from "./useRenderedSettingsPathname";

function Chrome() {
  return (
    <>
      <p data-testid="chrome">{useRenderedSettingsPathname()}</p>
      <Outlet />
    </>
  );
}

it("names the page on screen, not the one still loading", async () => {
  const slowPage = Promise.withResolvers<void>();
  const root = createRootRoute({ component: Chrome });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/settings/general",
        component: () => <p>General page</p>,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/settings/voice",
        // Stands in for a lazy route chunk that has not arrived yet.
        loader: () => slowPage.promise,
        component: () => <p>Voice page</p>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/settings/general"] }),
  });
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  const chrome = screen.getByTestId("chrome");
  await expect.element(chrome).toHaveTextContent("/settings/general");

  const navigation = router.navigate({ to: "/settings/voice" });
  await expect.poll(() => router.state.location.pathname).toBe("/settings/voice");
  await expect.element(screen.getByText("General page")).toBeVisible();
  await expect.element(chrome).toHaveTextContent("/settings/general");

  slowPage.resolve();
  await navigation;
  await expect.element(screen.getByText("Voice page")).toBeVisible();
  await expect.element(chrome).toHaveTextContent("/settings/voice");
});
