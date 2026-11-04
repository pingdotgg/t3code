import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { makeThreadFixture } from "../test-fixtures";
import type { Project, Thread } from "../types";
import { CommandPalette } from "./CommandPalette";

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
  handleNewThread: vi.fn(async () => undefined),
}));
vi.mock("../state/server", async (original) => {
  const actual = await original<typeof import("../state/server")>();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const { THREAD_JUMP_KEYBINDING_COMMANDS } = await import("@t3tools/contracts");
  // The default jump bindings are desktop-only; these hold in the browser too.
  const jumpBindings = compileResolvedKeybindingsConfig(
    THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
      key: `mod+${index + 1}`,
      command,
    })),
  );
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(jumpBindings) };
});
vi.mock("../hooks/useHandleNewThread", async (original) => {
  const actual = await original<typeof import("../hooks/useHandleNewThread")>();
  return {
    ...actual,
    useHandleNewThread: () => ({
      ...actual.useHandleNewThread(),
      handleNewThread: entities.handleNewThread,
    }),
  };
});
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => entities.projects,
  useVisibleThreadShells: () => entities.threads,
}));

function setup(state: { projects?: ReadonlyArray<Project>; threads?: ReadonlyArray<Thread> } = {}) {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  entities.projects = state.projects ?? [];
  entities.threads = state.threads ?? [];
  entities.handleNewThread.mockClear();
}

function makeProject(title: string): Project {
  return {
    id: ProjectId.make(title),
    environmentId: EnvironmentId.make("local"),
    title,
    workspaceRoot: `/work/${title}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    scripts: [],
  };
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

  it("numbers filtered New thread in... rows from 1", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    setup({ projects: [makeProject("server"), makeProject("lima")] });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });
    await userEvent.fill(page.getByPlaceholder("Search..."), "li");

    await expect.element(page.getByRole("option", { name: /server/ })).not.toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: /lima/ })).toMatchTextContent("Ctrl+1");
  });

  it("jump 1 starts a thread in the first filtered New thread in... row", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    setup({ projects: [makeProject("server"), makeProject("lima")] });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });
    await userEvent.fill(page.getByPlaceholder("Search..."), "li");
    await expect.element(page.getByRole("option", { name: /server/ })).not.toBeInTheDocument();
    await userEvent.keyboard("{Control>}1{/Control}");

    await vi.waitFor(() =>
      expect(entities.handleNewThread).toHaveBeenCalledWith({
        environmentId: EnvironmentId.make("local"),
        projectId: ProjectId.make("lima"),
      }),
    );
  });
});
