import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { LAST_USED_PROJECT_STORAGE_KEY } from "../hooks/useHandleNewThread";
import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import { makeThreadFixture } from "../test-fixtures";
import type { Project, Thread } from "../types";
import { openOrbitInstanceStep } from "../orbit/orbitInstanceStep";
import { CommandPalette } from "./CommandPalette";
import type { OrbitPaletteProjectsState } from "./CommandPalette.logic";
import type { OrbitGatewayEnvironment } from "@t3tools/client-runtime/orbit-gateway";

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => entities.projects,
  useVisibleThreadShells: () => entities.threads,
}));

const orbit = vi.hoisted(() => ({
  state: { status: "off" } as OrbitPaletteProjectsState,
  retry: vi.fn(),
  checkInstanceName: vi.fn(),
  openOrbitDraft: vi.fn(),
}));
vi.mock("../orbit/orbitPaletteProjects", () => ({
  recheckOrbitPaletteProjects: async () => false,
  useOrbitPaletteProjects: () => orbit.state,
  useOrbitPairedEnvironmentIds: () => new Set<string>(),
  retryOrbitPaletteProjects: () => orbit.retry(),
  checkOrbitInstanceName: (projectId: number, name: string) =>
    orbit.checkInstanceName(projectId, name),
}));
vi.mock("../orbit/openOrbitDraft", () => ({
  openOrbitDraft: async (...args: unknown[]) => orbit.openOrbitDraft(...args) ?? "draft-1",
}));

function orbitEnvironment(
  instanceId: number,
  projectId: number,
  instanceName: string,
): OrbitGatewayEnvironment {
  return {
    environmentId: `env-${instanceId}`,
    label: instanceName,
    url: `https://${instanceName}.example.test`,
    serverVersion: null,
    registeredBy: null,
    registeredAt: null,
    status: "registered",
    instanceId,
    powerState: "running",
    projectId,
    projectName: "nckrtl",
    projectSlug: "nckrtl",
    instanceName,
    nodeName: "beast",
    instanceUrl: `https://${instanceName}.nckrtl.test`,
  };
}

function setup(
  state: {
    projects?: ReadonlyArray<Project>;
    threads?: ReadonlyArray<Thread>;
    orbit?: OrbitPaletteProjectsState;
  } = {},
) {
  // Earlier browser test files share this origin's localStorage; a remembered project
  // that is not listed here hides the default "New thread in <project>" row.
  removeLocalStorageItem(LAST_USED_PROJECT_STORAGE_KEY);
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  entities.projects = state.projects ?? [];
  entities.threads = state.threads ?? [];
  orbit.state = state.orbit ?? { status: "off" };
  orbit.retry.mockReset();
  orbit.checkInstanceName.mockReset();
  orbit.openOrbitDraft.mockReset();
}

describe("CommandPalette open intents", () => {
  it("drags a searched thread into the current composer without navigating", async () => {
    const environmentId = EnvironmentId.make("remote");
    const threadId = ThreadId.make("dragged-thread");
    setup({
      threads: [makeThreadFixture({ environmentId, id: threadId, title: "Drag this thread" })],
    });
    const onDrop = vi.fn();
    await using screen = await render(
      <CommandPalette>
        <div
          data-thread-context-drop="true"
          ref={(node) => {
            node?.addEventListener("t3-thread-context-drop", onDrop);
          }}
          style={{ position: "fixed", bottom: 0, width: 300, height: 100 }}
        >
          Composer
        </div>
      </CommandPalette>,
    );
    const pathname = screen.router?.state.location.pathname;
    openCommandPalette({ query: "Drag this thread" });
    const row = page.getByRole("option", { name: /Drag this thread/ });
    await expect.element(row).toBeVisible();
    const bounds = row.element().getBoundingClientRect();
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      });
    await act(() => {
      row.element().dispatchEvent(pointer("pointerdown", bounds.x + 20, bounds.y + 10));
      document.dispatchEvent(pointer("pointermove", bounds.x + 30, bounds.y + 20));
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
    await act(() => {
      document.dispatchEvent(pointer("pointermove", 50, window.innerHeight - 30));
      document.dispatchEvent(pointer("pointerup", 50, window.innerHeight - 30));
    });
    expect(onDrop).toHaveBeenCalledOnce();
    expect((onDrop.mock.calls[0]![0] as CustomEvent).detail).toEqual([{ environmentId, threadId }]);
    expect(screen.router?.state.location.pathname).toBe(pathname);
  });

  it("opens New thread in... with focus in the search input, not the Back button", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
  });

  it("highlights the first project when New thread in... opens from the root list", async () => {
    const environmentId = EnvironmentId.make("local");
    const project = (id: string, title: string): Project => ({
      id: ProjectId.make(id),
      environmentId,
      title,
      workspaceRoot: `/work/${id}`,
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      scripts: [],
    });
    setup({
      projects: [project("acme", "Acme"), project("beta", "Beta"), project("gamma", "Gamma")],
    });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({});
    await expect
      .element(page.getByPlaceholder("Search commands, projects, and threads..."))
      .toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("option", { name: /^New thread in\.\.\./ }))
      .toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Enter}");

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
    await expect.element(page.getByRole("option").first()).toHaveAttribute("data-highlighted");
    await expect.element(page.getByRole("option").nth(1)).not.toHaveAttribute("data-highlighted");
  });

  it("opens a search intent with its query in the focused input", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "acme" });

    const input = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("acme");
  });

  it("opens a searched project's latest listed thread, not a newer subagent", async () => {
    const environmentId = EnvironmentId.make("local");
    const projectId = ProjectId.make("acme");
    const parentId = ThreadId.make("parent");
    setup({
      projects: [
        {
          id: projectId,
          environmentId,
          title: "Acme",
          workspaceRoot: "/work/acme",
          repositoryIdentity: null,
          defaultModelSelection: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          scripts: [],
        },
      ],
      threads: [
        makeThreadFixture({
          id: parentId,
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-02T00:00:00.000Z",
        }),
        makeThreadFixture({
          id: ThreadId.make("subagent"),
          environmentId,
          projectId,
          updatedAt: "2026-03-03T00:00:00.000Z",
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent",
          },
        }),
      ],
    });
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "Acme" });
    await page.getByRole("option", { name: /Acme/ }).first().click();

    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/local/parent"));
  });

  it("lists an Orbit Project with its instance count and offers Retry when Orbit is unreachable", async () => {
    const localProject: Project = {
      id: ProjectId.make("acme"),
      environmentId: EnvironmentId.make("local"),
      title: "Acme",
      workspaceRoot: "/work/acme",
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      scripts: [],
    };
    // A local project with the Orbit Project's name stays its own row: no deduplication.
    const namesake: Project = {
      ...localProject,
      id: ProjectId.make("nckrtl-local"),
      title: "nckrtl",
      workspaceRoot: "/work/nckrtl",
    };
    setup({
      projects: [localProject, namesake],
      orbit: {
        status: "loaded",
        projects: [
          {
            id: 3,
            slug: "nckrtl",
            name: "nckrtl",
            nodeId: 7,
            nodeName: "beast",
            instanceDomainSuffix: null,
            cloneable: true,
            cloneableReason: null,
            checks: null,
          },
        ],
        environments: [
          orbitEnvironment(41, 3, "fix"),
          orbitEnvironment(42, 3, "login"),
          orbitEnvironment(9, 3, "default"),
        ],
      },
    });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });
    await expect.element(page.getByRole("option", { name: /nckrtl/ }).nth(1)).toBeVisible();
    const row = page.getByRole("option", { name: /orbit · 2 instances/ });
    await expect.element(row).toBeVisible();
    expect(page.getByRole("option", { name: /nckrtl/ }).all()).toHaveLength(2);
    expect(row.element().textContent).toContain("orbit · 2 instances");
    await expect.element(page.getByRole("option", { name: /Acme/ })).toBeVisible();
    await row.click();
    await expect.element(page.getByRole("textbox", { name: "Instance name" })).toBeVisible();

    orbit.state = { status: "loading" };
    await act(() =>
      useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true),
    );
    openCommandPalette({ open: "new-thread-in" });
    await expect.element(page.getByText("Loading Orbit projects…")).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: /orbit · 2 instances/ }))
      .not.toBeInTheDocument();

    orbit.state = { status: "unreachable" };
    await act(() =>
      useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true),
    );
    openCommandPalette({ open: "new-thread-in" });
    await expect.element(page.getByRole("option", { name: /Acme/ })).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: /orbit · 2 instances/ }))
      .not.toBeInTheDocument();
    const notice = page.getByRole("option", { name: /Orbit projects are not shown/ });
    await expect.element(notice).toBeVisible();
    expect(notice.element().textContent).toContain("Retry");
    await notice.click();
    expect(orbit.retry).toHaveBeenCalledOnce();
  });

  it("checks a typed name, fills the name from a search without a match, and creates on Enter", async () => {
    setup({
      orbit: {
        status: "loaded",
        projects: [
          {
            id: 3,
            slug: "nckrtl",
            name: "nckrtl",
            nodeId: 7,
            nodeName: "beast",
            instanceDomainSuffix: ".nckrtl.test",
            cloneable: true,
            cloneableReason: null,
            checks: null,
          },
        ],
        environments: [orbitEnvironment(41, 3, "fix"), orbitEnvironment(42, 3, "login")],
      },
    });
    orbit.checkInstanceName.mockImplementation(async (_projectId: number, name: string) =>
      name === "fix"
        ? { name, available: false, reason: "taken", domain: null }
        : name.length > 30
          ? { name, available: false, reason: "domain_invalid", domain: null }
          : { name, available: true, reason: null, domain: `${name}.nckrtl.test` },
    );
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });
    await page.getByRole("option", { name: /orbit · 2 instances/ }).click();
    const nameField = page.getByRole("textbox", { name: "Instance name" });
    await expect.element(nameField).toBeVisible();
    await expect.element(page.getByRole("option", { name: /fix/ })).toBeVisible();
    await expect.element(page.getByText("Becomes the branch and the domain.")).toBeVisible();

    await userEvent.type(nameField, "fix");
    await expect.element(page.getByText("fix is taken in nckrtl.")).toBeVisible();
    await userEvent.clear(nameField);
    await userEvent.type(nameField, "a-name-that-makes-the-address-too-long");
    await expect
      .element(page.getByText("This name makes the address too long. Use a shorter name."))
      .toBeVisible();
    await userEvent.clear(nameField);
    await userEvent.type(nameField, "pricing");
    await expect.element(page.getByText("pricing.nckrtl.test is available.")).toBeVisible();
    await userEvent.clear(nameField);

    const search = page.getByPlaceholder("Search instances…");
    await userEvent.type(search, "New Page");
    await expect.element(page.getByText("Nothing found.")).toBeVisible();
    await expect.element(nameField).toHaveValue("new-page");
    await expect.element(page.getByText("new-page.nckrtl.test is available.")).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(orbit.openOrbitDraft).toHaveBeenCalledOnce());
    expect(orbit.openOrbitDraft.mock.calls[0]![1]).toMatchObject({
      projectId: 3,
      instanceKind: "new",
      instanceName: "new-page",
      existing: null,
      domainSuffix: ".nckrtl.test",
    });
  });

  it("reopens the Instance step from the composer's chip with the draft's name filled in", async () => {
    setup({ orbit: { status: "loading" } });
    orbit.checkInstanceName.mockResolvedValue({
      name: "pricing",
      available: true,
      reason: null,
      domain: null,
    });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    await act(() =>
      openOrbitInstanceStep({
        projectId: 3,
        projectSlug: "nckrtl",
        projectName: "nckrtl",
        nodeName: "beast",
        instanceKind: "new",
        instanceName: "pricing",
        existing: null,
        domainSuffix: ".nckrtl.test",
      }),
    );
    const nameField = page.getByRole("textbox", { name: "Instance name" });
    await expect.element(nameField).toHaveValue("pricing");
    await expect.element(page.getByText(".nckrtl.test")).toBeVisible();
    await expect.element(page.getByText("pricing is available.")).toBeVisible();
    // The list is still loading: skeleton rows under the label, the name field already works.
    await expect.element(page.getByText("Existing instances")).toBeVisible();
  });

  it("retries a failed instance list on Enter instead of creating", async () => {
    setup({ orbit: { status: "unreachable" } });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    await act(() =>
      openOrbitInstanceStep({
        projectId: 3,
        projectSlug: "nckrtl",
        projectName: "nckrtl",
        nodeName: "beast",
        instanceKind: "new",
        instanceName: "",
        existing: null,
        domainSuffix: null,
      }),
    );
    await expect
      .element(page.getByRole("option", { name: /Could not load the instances of nckrtl/ }))
      .toBeVisible();
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(orbit.retry).toHaveBeenCalledOnce());
    expect(orbit.openOrbitDraft).not.toHaveBeenCalled();
  });
});
