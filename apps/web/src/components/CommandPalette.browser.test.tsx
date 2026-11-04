import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { makeThreadFixture } from "../test-fixtures";
import type { Project, Thread } from "../types";
import { CommandPalette } from "./CommandPalette";

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => entities.projects,
  useVisibleThreadShells: () => entities.threads,
}));

function setup(state: { projects?: ReadonlyArray<Project>; threads?: ReadonlyArray<Thread> } = {}) {
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  entities.projects = state.projects ?? [];
  entities.threads = state.threads ?? [];
}

describe("CommandPalette open intents", () => {
  it("opens New thread in... with focus in the search input, not the Back button", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
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
});

it("opens history in the active draft's environment and project", async () => {
  setup();
  const projectRef = {
    environmentId: EnvironmentId.make("remote-machine"),
    projectId: ProjectId.make("second-project"),
  };
  const draftId = DraftId.make("history-draft");
  useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId);
  const root = createRootRoute();
  const draft = createRoute({
    getParentRoute: () => root,
    path: "/draft/$draftId",
    component: () => <CommandPalette>{null}</CommandPalette>,
  });
  const history = createRoute({
    getParentRoute: () => root,
    path: "/history",
    component: () => <div>History destination</div>,
  });
  const router = createRouter({
    routeTree: root.addChildren([draft, history]),
    history: createMemoryHistory({ initialEntries: ["/draft/history-draft"] }),
  });
  // This test owns a router with real draft route parameters.
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  await act(() => openCommandPalette({ query: "Open agent history" }));
  await page.getByText("Open agent history", { exact: true }).click();
  await expect.element(screen.getByText("History destination")).toBeVisible();
  await vi.waitFor(() => expect(router.state.location.search).toEqual(projectRef));
});
