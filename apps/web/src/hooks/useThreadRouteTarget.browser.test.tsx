import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useShownThreadRouteTarget } from "./useThreadRouteTarget";

function ShownTarget() {
  const { target } = useShownThreadRouteTarget();
  const label =
    target === null
      ? "none"
      : target.kind === "server"
        ? `${target.threadRef.environmentId}/${target.threadRef.threadId}`
        : `draft ${target.draftId}`;
  return <output aria-label="Shown thread">{label}</output>;
}

it("keeps the thread that opened Settings or Usage until another thread opens", async () => {
  const root = createRootRoute({
    component: () => (
      <>
        <ShownTarget />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren(
      ["/$environmentId/$threadId", "/draft/$draftId", "/settings/general", "/usage"].map((path) =>
        createRoute({ getParentRoute: () => root, path }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ["/env-1/thread-1"] }),
  });
  await router.load();
  // The hook reads thread and modal params, so the routes must exist for real.
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  const shown = page.getByRole("status", { name: "Shown thread" });

  await expect.element(shown).toHaveTextContent("env-1/thread-1");
  await router.navigate({ to: "/settings/general" });
  await router.navigate({ to: "/usage" });
  await expect.element(shown).toHaveTextContent("env-1/thread-1");

  await router.navigate({ to: "/draft/$draftId", params: { draftId: "draft-1" } });
  await router.navigate({ to: "/settings/general" });
  await expect.element(shown).toHaveTextContent("draft draft-1");
});
