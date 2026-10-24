import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import {
  clearComposerDraftsEnvironment,
  DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { primaryServerKeybindingsAtom } from "../state/server";
import { AppSidebarLayout } from "./AppSidebarLayout";

const environmentId = EnvironmentId.make("shortcut-environment");
const projectId = ProjectId.make("shortcut-project");
const projects = [
  {
    environmentId,
    id: projectId,
    title: "Shortcut project",
    defaultModelSelection: null,
    defaultThreadEnvMode: "local" as const,
    workspaceRoot: "/workspace/shortcut-project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  },
];

// Keep draft creation and routing real; the sidebar's thread list is unrelated to shortcuts.
vi.mock("./Sidebar", () => ({ default: () => null }));
vi.mock("./LegacySidebar", () => ({ default: () => null }));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => projects,
  readProjects: () => projects,
  readProject: () => projects[0] ?? null,
  readThreadShells: () => [],
  useQuietThreadShell: () => null,
}));
vi.mock(import("@effect/atom-react"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomValue: ((atom: Parameters<typeof actual.useAtomValue>[0]) =>
      atom === primaryServerKeybindingsAtom
        ? DEFAULT_RESOLVED_KEYBINDINGS
        : actual.useAtomValue(atom)) as typeof actual.useAtomValue,
  };
});
vi.mock("../lib/t3ProjectFileDefaults", () => ({ readT3ProjectFile: async () => null }));

it.each([
  ["/usage", "Linux x86_64", "{Control>}{Shift>}n{/Shift}{/Control}"],
  ["/usage", "MacIntel", "{Meta>}{Shift>}n{/Shift}{/Meta}"],
  ["/usage", "MacIntel", "{Meta>}{Shift>}o{/Shift}{/Meta}"],
  ["/usage", "Linux x86_64", "{Control>}{Shift>}o{/Shift}{/Control}"],
  ["/settings/general", "Linux x86_64", "{Control>}{Shift>}n{/Shift}{/Control}"],
  ["/projects/shortcut-project", "Linux x86_64", "{Control>}{Shift>}n{/Shift}{/Control}"],
])("opens a project draft from %s on %s with %s", async (path, platform, shortcut) => {
  clearComposerDraftsEnvironment(environmentId);
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  await using screen = await render(<AppSidebarLayout>{null}</AppSidebarLayout>, { router: path });

  await userEvent.keyboard(shortcut);

  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toMatch(/^\/draft\//));
  const draftId = screen.router!.state.location.pathname.slice("/draft/".length);
  expect(useComposerDraftStore.getState().getDraftSession(DraftId.make(draftId))).toMatchObject({
    environmentId,
    projectId,
  });
});

it.each(["keybinding capture", "terminal", "command palette"])(
  "leaves new-thread shortcuts alone during %s",
  async (context) => {
    clearComposerDraftsEnvironment(environmentId);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(
      <AppSidebarLayout>
        <input
          aria-label="Focused control"
          data-keybinding-capture={context === "keybinding capture" ? "" : undefined}
          data-terminal-owner={context === "terminal" ? "drawer" : undefined}
          data-command-palette={context === "command palette" ? "" : undefined}
        />
      </AppSidebarLayout>,
      { router: "/usage" },
    );
    await screen.getByRole("textbox", { name: "Focused control" }).click();

    await userEvent.keyboard("{Control>}{Shift>}n{/Shift}{/Control}");

    expect(screen.router?.state.location.pathname).toBe("/usage");
    expect(
      Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey).filter(
        (draft) => draft.environmentId === environmentId,
      ),
    ).toEqual([]);
  },
);
