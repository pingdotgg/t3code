import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  primary: null as string | null,
  environments: [] as Array<{
    environmentId: string;
    label: string;
    connection: { phase: "connected" };
    serverConfig: { environment: { capabilities: { linear: boolean } } };
  }>,
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => state.primary,
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ChatMarkdown", () => ({ default: () => null }));
vi.mock("./LinearWorkspace", () => ({
  LinearWorkspace: ({ environmentId }: { environmentId: string }) => (
    <div>Workspace for {environmentId}</div>
  ),
}));

import { LinearPage } from "./LinearPage";
import { parseLinearSearch } from "./linearSearch";

function environment(id: string, linear = true) {
  return {
    environmentId: id,
    label: id,
    connection: { phase: "connected" as const },
    serverConfig: { environment: { capabilities: { linear } } },
  };
}
function testRouter(path: string) {
  const root = createRootRoute();
  return createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/linear",
        validateSearch: parseLinearSearch,
        component: LinearPage,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

it("opens a connected remote workspace without a primary environment", async () => {
  state.primary = null;
  state.environments = [environment("saved-remote")];
  const router = testRouter("/linear");
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  await expect.element(screen.getByText("Workspace for saved-remote")).toBeVisible();
});

it("keeps capable remotes reachable and clears workspace IDs when switching", async () => {
  state.primary = "local";
  state.environments = [environment("local", false), environment("first"), environment("second")];
  const router = testRouter(
    "/linear?view=all&team=old-team&issue=old-issue&project=old-project&q=old-query",
  );
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  await expect.element(screen.getByText("Workspace for first")).toBeVisible();
  await screen.getByRole("combobox", { name: "Environment" }).click();
  await page.getByRole("option", { name: "second" }).click();
  await expect.element(screen.getByText("Workspace for second")).toBeVisible();
  await expect.poll(() => router.state.location.search).toEqual({ view: "all" });
});
