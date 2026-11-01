import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { CommandPalette } from "./CommandPalette";

const state = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<EnvironmentProject>,
  scratchEnvironmentId: null as EnvironmentId | null,
}));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => state.projects,
}));
vi.mock(import("~/hooks/useScratchProject"), () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => state.scratchEnvironmentId,
    scratchWorkspaceRootFor: () => "/scratch",
    startScratchThread: async () => {},
    openScratchProject: async () => null,
  }),
}));

function setup() {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  state.projects = [];
  state.scratchEnvironmentId = null;
}

describe("CommandPalette open intents", () => {
  it("opens New thread in... with focus in the search input, not the Back button", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
  });

  it.each([
    {
      savedTitle: "Acme notes",
      query: "without project",
      command: "New thread in Acme notes (without a project)",
    },
    {
      savedTitle: "Acme notes",
      query: "Acme notes",
      command: "New thread in Acme notes (without a project)",
    },
    { savedTitle: null, query: "without project", command: "New thread without a project" },
  ])(
    "finds the scratch command for $query with saved title $savedTitle",
    async ({ savedTitle, query, command }) => {
      setup();
      state.scratchEnvironmentId = EnvironmentId.make("scratch-environment");
      if (savedTitle !== null) {
        state.projects = [
          {
            id: ProjectId.make("scratch-project"),
            environmentId: state.scratchEnvironmentId,
            title: savedTitle,
            workspaceRoot: "/scratch",
            isScratch: true,
            repositoryIdentity: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-29T00:00:00Z",
            updatedAt: "2026-10-29T00:00:00Z",
          },
        ];
      }
      await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

      openCommandPalette({ query });

      const input = page.getByPlaceholder("Search commands, projects, and threads...");
      await expect.element(input).toHaveFocus();
      await expect.element(input).toHaveValue(query);
      await expect
        .element(
          page.getByRole("option", {
            name: new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          }),
        )
        .toBeVisible();
    },
  );
});
