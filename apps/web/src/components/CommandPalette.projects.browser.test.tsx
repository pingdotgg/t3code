import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type { Project } from "../types";
import { CommandPalette } from "./CommandPalette";
import { openCommandPalette } from "../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../state/server";

const projectState = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    projects: [] as Project[],
    scratchRoots: new Map<EnvironmentId, string>(),
    handleNewThread: vi.fn(async () => undefined),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setProjects(projects: Project[]) {
      this.projects = projects;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useParams: () => null,
  useLocation: () => "/settings",
}));
vi.mock("@effect/atom-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...original,
    useAtomValue: (atom: unknown) =>
      atom === primaryServerKeybindingsAtom ? DEFAULT_RESOLVED_KEYBINDINGS : [],
  };
});
vi.mock("../hooks/useTheme", () => ({
  useRenderedAppearance: () => "light",
  useTheme: () => ({ theme: "default", resolvedTheme: "light", appearanceMode: "light" }),
}));
vi.mock("../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useSettings")>()),
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => projectState.scratchRoots.keys().next().value ?? null,
    scratchWorkspaceRootFor: (environmentId: EnvironmentId) =>
      projectState.scratchRoots.get(environmentId) ?? null,
  }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => vi.fn() }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    defaultProjectRef: null,
    handleNewThread: projectState.handleNewThread,
  }),
}));
vi.mock("./ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  useProjects: () => useSyncExternalStore(projectState.subscribe, () => projectState.projects),
  useThreadShells: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../state/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/queries")>()),
  useThreadSearch: () => ({ matches: [] }),
}));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  useEnvironmentScope: () => false,
}));
vi.mock("../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({}),
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

function setup(): Disposable {
  const reset = () => {
    projectState.projects = [];
    projectState.scratchRoots.clear();
    projectState.handleNewThread.mockClear();
  };
  reset();
  return { [Symbol.dispose]: reset };
}

const localEnvironmentId = EnvironmentId.make("picker-local");
const remoteEnvironmentId = EnvironmentId.make("picker-remote");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("local-project"),
    environmentId: localEnvironmentId,
    title: "shared-repo",
    workspaceRoot: "/local/shared-repo",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6.1-sol",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function projectRows() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-item"]'));
}

async function openProjectPicker(entryPoint: "shortcut" | "submenu") {
  await act(() =>
    openCommandPalette(entryPoint === "shortcut" ? { open: "new-thread-in" } : undefined),
  );
  if (entryPoint === "submenu") {
    await expect
      .poll(() => projectRows().find((row) => row.textContent?.includes("New thread in...")))
      .toBeDefined();
    const submenu = projectRows().find((row) => row.textContent?.includes("New thread in..."));
    await act(() => submenu!.click());
  }
}

describe.each(["shortcut", "submenu"] as const)("project picker via %s", (entryPoint) => {
  it("removes duplicate No project rows when a host's scratch config arrives", async () => {
    using _projects = setup();
    const remoteScratch = makeProject({
      id: ProjectId.make("remote-scratch"),
      environmentId: remoteEnvironmentId,
      title: "No project",
      workspaceRoot: "/remote/scratch",
    });
    projectState.projects = [makeProject(), remoteScratch];
    projectState.scratchRoots.set(localEnvironmentId, "/local/scratch");
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>, { router: false });
    await openProjectPicker(entryPoint);
    await expect
      .poll(() => projectRows().filter((row) => row.textContent?.includes("No project")))
      .toHaveLength(2);

    projectState.scratchRoots.set(remoteEnvironmentId, remoteScratch.workspaceRoot);
    await act(() =>
      projectState.setProjects([makeProject(), { ...remoteScratch, isScratch: true }]),
    );

    await expect
      .poll(() => projectRows().filter((row) => row.textContent?.includes("No project")))
      .toHaveLength(1);
    expect(projectRows().some((row) => row.textContent?.includes("/remote/scratch"))).toBe(false);
  });

  it("regroups host checkouts and selects a newly arrived project without reopening", async () => {
    using _projects = setup();
    projectState.projects = [
      makeProject(),
      makeProject({
        id: ProjectId.make("remote-project"),
        environmentId: remoteEnvironmentId,
        workspaceRoot: "/remote/shared-repo",
      }),
    ];
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>, { router: false });
    await openProjectPicker(entryPoint);
    await expect.poll(projectRows).toHaveLength(2);

    const repositoryIdentity = {
      canonicalKey: "github.com/example/shared-repo",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    };
    const arrivingProject = makeProject({
      id: ProjectId.make("arriving-project"),
      title: "Arriving project",
      workspaceRoot: "/local/arriving",
    });
    await act(() =>
      projectState.setProjects([
        ...projectState.projects.map((project) => ({ ...project, repositoryIdentity })),
        arrivingProject,
      ]),
    );

    await expect
      .poll(() => projectRows().filter((row) => row.textContent?.includes("shared-repo")))
      .toHaveLength(1);
    const rows = projectRows();
    const arrivingRow = rows.find((row) => row.textContent?.includes("Arriving project"));
    expect(arrivingRow).toBeDefined();
    await act(() => arrivingRow!.click());
    expect(projectState.handleNewThread).toHaveBeenCalledWith({
      environmentId: arrivingProject.environmentId,
      projectId: arrivingProject.id,
    });
  });
});
