import {
  Outlet,
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SettingsBreadcrumb } from "./SettingsBreadcrumb";

vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedProjectModel: () => ({
    isLoading: false,
    projectGroups: [{ projectKey: "project-alpha", displayName: "Alpha Project" }],
  }),
}));

function createArchiveRouter(initialEntry: string, pauseArchive: boolean) {
  let markArchiveStarted = () => {};
  let releaseArchive = () => {};
  const archiveStarted = new Promise<void>((resolve) => {
    markArchiveStarted = resolve;
  });
  const archiveReleased = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });

  const rootRoute = createRootRoute({
    component: Outlet,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "settings",
    component: SettingsTestLayout,
  });
  const generalRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "general",
    component: () => <div>General settings</div>,
  });
  const archivedRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "archived",
    validateSearch: (search): { project?: string } =>
      typeof search.project === "string" ? { project: search.project } : {},
    beforeLoad: async () => {
      if (!pauseArchive) return;
      markArchiveStarted();
      await archiveReleased;
    },
    component: () => <div>Archived threads</div>,
  });
  const routeTree = rootRoute.addChildren([
    settingsRoute.addChildren([generalRoute, archivedRoute]),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  return { archiveStarted, releaseArchive, router };
}

function SettingsTestLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <>
      <SettingsBreadcrumb pathname={pathname} />
      <Outlet />
    </>
  );
}

function renderBreadcrumb(router: ReturnType<typeof createArchiveRouter>["router"]) {
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <SettingsBreadcrumb pathname={router.state.location.pathname} />
    </RouterContextProvider>,
  );
}

describe("SettingsBreadcrumb", () => {
  it("waits for the Archive match before reading its search during navigation", async () => {
    const { archiveStarted, releaseArchive, router } = createArchiveRouter(
      "/settings/general",
      true,
    );
    await router.load();

    const navigation = router.navigate({
      to: "/settings/archived",
      search: { project: "project-alpha" },
    });
    await archiveStarted;

    expect(router.state.location.pathname).toBe("/settings/archived");
    expect(router.state.matches.some((match) => match.routeId === "/settings/archived")).toBe(
      false,
    );
    const pendingMarkup = renderBreadcrumb(router);
    expect(pendingMarkup).toContain('aria-label="Settings breadcrumb"');
    expect(pendingMarkup).toContain("Settings");
    expect(pendingMarkup).toContain("Archive");

    releaseArchive();
    await navigation;

    const archiveMarkup = renderBreadcrumb(router);
    expect(archiveMarkup).toContain("Archive");
    expect(archiveMarkup).toContain("Alpha Project");

    await router.navigate({ to: "/settings/general" });
    const generalMarkup = renderBreadcrumb(router);
    expect(generalMarkup).toContain("General");
    expect(generalMarkup).not.toContain("Alpha Project");
  });

  it("preserves the selected project on a direct Archive deep link", async () => {
    const { router } = createArchiveRouter("/settings/archived?project=project-alpha", false);
    await router.load();

    const markup = renderBreadcrumb(router);
    expect(router.state.location.search.project).toBe("project-alpha");
    expect(markup).toContain("Alpha Project");
  });
});
