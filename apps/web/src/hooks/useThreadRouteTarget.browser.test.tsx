import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { startMainAppLocationTracking } from "../components/sidebar/mainAppLocation";
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

async function setup() {
  const root = createRootRoute({
    component: () => (
      <>
        <ShownTarget />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      ...[
        "/",
        "/$environmentId/$threadId",
        "/draft/$draftId",
        "/settings/general",
        "/settings/projects",
        "/usage",
      ].map((path) => createRoute({ getParentRoute: () => root, path })),
      createRoute({
        getParentRoute: () => root,
        path: "/projects/$projectKey",
        beforeLoad: () => {
          throw redirect({ to: "/settings/projects", replace: true });
        },
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/env-1/thread-1"] }),
  });
  await router.load();
  return { router, [Symbol.dispose]: startMainAppLocationTracking(router) };
}

// The hook reads thread and modal params, so the routes must exist for real.
const renderApp = (router: Awaited<ReturnType<typeof setup>>["router"]) =>
  render(<RouterProvider router={router} />, { router: false });

const shown = page.getByRole("status", { name: "Shown thread" });

it("keeps the thread that opened Settings or Usage until another thread opens", async () => {
  using app = await setup();
  const { router } = app;
  await using _screen = await renderApp(router);

  await expect.element(shown).toHaveTextContent("env-1/thread-1");
  await router.navigate({ to: "/settings/general" });
  await router.navigate({ to: "/usage" });
  await expect.element(shown).toHaveTextContent("env-1/thread-1");

  await router.navigate({ to: "/draft/$draftId", params: { draftId: "draft-1" } });
  await router.navigate({ to: "/settings/general" });
  await expect.element(shown).toHaveTextContent("draft draft-1");

  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: "env-1", threadId: "thread-2" },
  });
  await router.navigate({ to: "/settings/general" });
  await expect.element(shown).toHaveTextContent("env-1/thread-2");
});

it("gives a consumer that mounts under Settings the thread behind it", async () => {
  using app = await setup();
  const { router } = app;
  {
    await using _screen = await renderApp(router);
    await expect.element(shown).toHaveTextContent("env-1/thread-1");
    await router.navigate({ to: "/settings/general" });
  }

  // Like the sidebar remounting when the viewport crosses the mobile breakpoint.
  await using _remounted = await renderApp(router);
  await expect.element(shown).toHaveTextContent("env-1/thread-1");
});

it("keeps the thread under Settings reached through a project link, and none from home", async () => {
  using app = await setup();
  const { router } = app;
  await using _screen = await renderApp(router);

  await router.navigate({ to: "/projects/$projectKey", params: { projectKey: "project-1" } });
  await expect.element(shown).toHaveTextContent("env-1/thread-1");

  await router.navigate({ to: "/" });
  await router.navigate({ to: "/settings/general" });
  await expect.element(shown).toHaveTextContent("none");
});
