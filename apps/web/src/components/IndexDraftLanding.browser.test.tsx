import { IndexDraftLanding } from "./IndexDraftLanding";
import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { PROJECT_COLLECTIONS_STORAGE_KEY } from "../projectCollections";
import type { Project } from "../types";
import { PERSISTED_STATE_KEY, useUiStateStore } from "../uiStateStore";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";

const fixture = vi.hoisted(() => ({
  projects: new Array<Project>(),
  started: new Array<ScopedProjectRef>(),
}));

vi.mock("../hooks/useSidebarProjectGroups", () => ({
  useSidebarProjectGroups: () =>
    buildSidebarProjectSnapshots({
      projects: fixture.projects,
      settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
      primaryEnvironmentId: null,
      groupScratchProjects: true,
      resolveEnvironmentLabel: () => null,
    }),
}));

vi.mock("../hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  return {
    ...(await importOriginal<typeof import("../hooks/useSettings")>()),
    useClientSettings: (selector?: (settings: ClientSettings) => unknown) =>
      selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ state: { location: { pathname: "/" } } }),
}));
vi.mock("../state/entities", () => ({
  useProjects: () => fixture.projects,
  useThreadShells: () => [],
  useQuietThreadShells: () => [],
  useDelegatedUnderParent: () => new Set(),
  useAllEnvironmentShellsBootstrapped: () => true,
  readProject: () => ({}),
}));
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  useEnvironments: () => ({ environments: [], isReady: true }),
  useEnvironmentIdentities: () => [],
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => async (ref: ScopedProjectRef) => {
    fixture.started.push(ref);
    return {};
  },
}));
vi.mock("../components/NoProjectsHero", () => ({ NoProjectsHero: () => null }));
vi.mock("../components/HostedEmptyState", () => ({ HostedEmptyState: () => null }));
vi.mock("../components/WorkspacePageHeader", () => ({ WorkspacePageHeader: () => null }));

function setup(memberTitles: readonly string[]) {
  const previous = useUiStateStore.getState();
  const stored = [PROJECT_COLLECTIONS_STORAGE_KEY, PERSISTED_STATE_KEY].map(
    (key) => [key, localStorage.getItem(key)] as const,
  );
  fixture.projects = ["Beta", "Alpha"].map((title, index): Project => ({
    id: ProjectId.make(title),
    environmentId: EnvironmentId.make("env"),
    title,
    workspaceRoot: `/${title}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: index === 0 ? "2026-06-01T00:00:00Z" : "2026-01-01T00:00:00Z",
  }));
  fixture.started = [];
  const members = memberTitles.map((title) => ({
    kind: "project" as const,
    physicalKey: `env:/${title}`,
    label: title,
    repositoryKey: null,
    repositoryPathKey: null,
  }));
  const collections = [{ id: "work", name: "Work", members }];
  localStorage.setItem(PROJECT_COLLECTIONS_STORAGE_KEY, JSON.stringify(collections));
  useUiStateStore.setState({ projectCollections: collections, activeProjectCollectionId: "work" });
  return {
    [Symbol.dispose]() {
      useUiStateStore.setState(previous);
      for (const [key, value] of stored) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

it("starts Home's draft in the selected group instead of the newest excluded project", async () => {
  using _state = setup(["Alpha"]);
  // The router shell is replaced so the real landing component stays on Home.
  await using _screen = await render(<IndexDraftLanding />, { router: false });
  await vi.waitFor(() => expect(fixture.started).toHaveLength(1));
  expect(fixture.started[0]).toMatchObject({ projectId: "Alpha" });
});

it("keeps Home empty when the selected group has no projects", async () => {
  using _state = setup([]);
  // The router shell is replaced so the real landing component stays on Home.
  await using screen = await render(<IndexDraftLanding />, { router: false });
  await expect
    .element(screen.getByText("No projects in this group", { exact: true }))
    .toBeVisible();
  expect(fixture.started).toEqual([]);
});
