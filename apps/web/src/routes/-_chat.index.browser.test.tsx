import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const fixture = vi.hoisted(() => ({
  openThread: vi.fn(),
  project: { environmentId: "environment-test", id: "project-test" },
}));

vi.mock("../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => fixture.openThread,
}));
vi.mock("../state/entities", () => ({
  readProject: () => fixture.project,
  useProjects: () => [fixture.project],
  useThreadShells: () => [],
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("../components/Sidebar.logic", () => ({
  sortScopedProjectsForSidebar: () => [fixture.project],
}));
vi.mock("../components/NoProjectsHero", () => ({ NoProjectsHero: () => null }));
vi.mock("../components/HostedEmptyState", () => ({ HostedEmptyState: () => null }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [], isReady: true }),
}));

import { Route } from "./_chat.index";

function setup() {
  fixture.openThread.mockReset();
  // A second unexpected attempt rejects so the pre-fix retry loop terminates.
  fixture.openThread.mockResolvedValueOnce(null).mockRejectedValue(new Error("Unavailable"));
  vi.spyOn(Route, "useRouteContext").mockReturnValue({
    authGateState: { status: "authenticated" },
  } as never);
}

it("waits for a manual retry after the environment refuses draft creation", async () => {
  setup();
  const IndexRoute = Route.options.component!;
  await using screen = await render(<IndexRoute />);
  await expect.element(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(fixture.openThread).toHaveBeenCalledTimes(1);

  await screen.getByRole("button", { name: "Try again" }).click();
  await vi.waitFor(() => expect(fixture.openThread).toHaveBeenCalledTimes(2));
  await expect.element(screen.getByRole("button", { name: "Try again" })).toBeVisible();
});
