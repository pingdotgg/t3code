import { RegistryContext, RegistryProvider } from "@effect/atom-react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { PropsWithChildren } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  offline: false,
  writable: true,
  project: false,
  missing: false,
  skillText: "# Review\nCheck changes.\n",
  extraFile: false,
  linkPaused: false,
  linkStopped: false,
  serverGeneration: 0,
  environmentScope: false,
  projectPath: "/project",
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runAtomCommand: async (
      _registry: unknown,
      _command: unknown,
      params: { input: { action: string; generation?: number } },
    ) => {
      const { input } = params;
      if (input.generation === undefined || input.generation === state.serverGeneration) {
        state.linkPaused = input.action === "pause";
        state.linkStopped = input.action === "remove";
      }
      return { _tag: "Success", value: undefined };
    },
  } as typeof actual;
});

vi.mock(import("../../state/agentFileSync"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const globalCatalog = Atom.make(
    AsyncResult.success({
      skills: [{ path: ".agents/skills/review", name: "Review" }],
      instructions: [
        {
          path: ".claude/CLAUDE.md",
          contents: "Global instructions.\n",
          sections: [
            { id: "Introduction:0", title: "Introduction", contents: "Global instructions.\n" },
          ],
        },
      ],
      warnings: [],
    }),
  );
  const emptyCatalog = Atom.make(
    AsyncResult.success({ skills: [], instructions: [], warnings: [] }),
  );
  const projectCatalog = Atom.make(
    AsyncResult.success({
      skills: [{ path: ".agents/skills/review", name: "Project review" }],
      instructions: [
        {
          path: "AGENTS.md",
          contents:
            Array.from({ length: 205 }, (_, index) => `Project line ${index + 1}`).join("\n") +
            "\nInherited instruction.\n",
          sections: [{ id: "Local:0", title: "Local", contents: "Project line 1\n" }],
        },
      ],
      warnings: [],
    }),
  );
  const sourceLinks = Atom.make(
    AsyncResult.success([
      {
        id: "shared-instructions",
        scope: { cwd: "/project" },
        sourceEnvironmentId: "available",
        selection: {
          cwd: "/remote",
          skills: [],
          instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }],
        },
        label: "Office",
        paused: false,
        error: null,
        lastSyncedAt: 0,
        generation: 0,
        revision: "initial",
      },
    ]),
  );
  const destinationLinks = Atom.make(() =>
    AsyncResult.success(
      state.linkStopped
        ? []
        : [
            {
              id: "shared-review",
              scope: {},
              sourceEnvironmentId: "source",
              selection: { skills: [".agents/skills/review"], instructions: [] },
              label: "source",
              paused: state.linkPaused,
              error: null,
              lastSyncedAt: 0,
              generation: 0,
              revision: "initial",
            },
          ],
    ),
  );
  const exported = Atom.make(() =>
    AsyncResult.success([
      {
        kind: "skill",
        path: ".agents/skills/review",
        files: [
          { path: "SKILL.md", data: btoa(state.skillText), mode: 384 },
          ...(state.extraFile
            ? [{ path: "notes.txt", data: btoa("Supporting notes."), mode: 384 }]
            : []),
        ],
      },
    ]),
  );
  const permissionAtom = Atom.family((id: string) =>
    Atom.make(() => id !== "unavailable" || state.writable),
  );
  return {
    agentFileSync: {
      list: ({ input }: { input: { cwd?: string } }) =>
        state.missing ? emptyCatalog : input.cwd ? projectCatalog : globalCatalog,
      links: ({ environmentId }: { environmentId: string }) =>
        environmentId === "available" ? destinationLinks : sourceLinks,
      export: () => exported,
      apply: { permissionAtom },
      manage: { permissionAtom },
    },
  } as never;
});
vi.mock(import("../../state/environments"), () => ({
  useEnvironments: (() => ({
    environments: ["source", "available", "unavailable"].map((id) => ({
      environmentId: id,
      label: id,
      connection: { phase: id === "unavailable" && state.offline ? "offline" : "connected" },
      serverConfig: { environment: { capabilities: { agentFileSync: true } } },
    })),
  })) as never,
}));
vi.mock(import("./SettingsScopeContext"), () => ({
  useSettingsScope: (() => ({
    scope: state.project
      ? {
          kind: "project",
          label: "Project",
          group: {
            memberProjects: [
              {
                environmentId: "source",
                physicalProjectKey: "source-project",
                workspaceRoot: state.projectPath,
              },
            ],
          },
        }
      : state.environmentScope
        ? { kind: "environment", environmentId: "source", label: "source" }
        : { kind: "all", label: "All projects" },
    environment: { environmentId: "source" },
  })) as never,
}));
vi.mock(import("./settingsLayout"), () => ({
  SettingsPageContainer: ({ children }: PropsWithChildren) => <>{children}</>,
  SettingsSection: ({ children }: PropsWithChildren) => <>{children}</>,
}));

import { AgentFileSyncSettings } from "./AgentFileSyncSettings";

function setup(reason = "") {
  state.offline = reason === "offline";
  state.writable = reason !== "read-only";
  state.project = reason === "project";
  state.missing = reason === "missing";
  state.skillText = "# Review\nCheck changes.\n";
  state.extraFile = false;
  state.linkPaused = false;
  state.linkStopped = false;
  state.serverGeneration = 0;
  state.environmentScope = reason === "environment";
  state.projectPath = "/project";
  const key = "t3:agent-file-sync:source:home";
  localStorage.setItem(`${key}:targets`, JSON.stringify(["available", "unavailable"]));
  return key;
}

it.each(["offline", "read-only"])(
  "can deselect a saved %s destination and review the remaining destination",
  async (reason) => {
    const key = setup(reason);
    await using screen = await render(
      <RegistryProvider>
        <AgentFileSyncSettings />
      </RegistryProvider>,
    );
    await userEvent.click(screen.getByText("Share this skill…", { exact: true }));
    const review = screen.getByRole("button", { name: "Review automatic sync" });
    await expect.element(review).toBeDisabled();
    const unavailable = screen.getByRole("checkbox", { name: /^unavailable/ });
    await expect.element(unavailable).toBeChecked();
    await expect.element(unavailable).toBeEnabled();
    await userEvent.click(unavailable);
    await expect.element(unavailable).not.toBeChecked();
    await expect.element(unavailable).toBeDisabled();
    await expect.element(review).toBeEnabled();
    expect(JSON.parse(localStorage.getItem(`${key}:targets`)!)).toEqual(["available"]);
  },
);

it("browses project and global files and reads the complete instruction file across line pages", async () => {
  setup("project");
  await using screen = await render(
    <RegistryProvider>
      <AgentFileSyncSettings />
    </RegistryProvider>,
  );
  await expect
    .element(screen.getByRole("button", { name: /Project review.*Project/ }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: /^Review.*Global/ })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /^AGENTS.md.*Project/ }));
  await expect.element(screen.getByText("Project line 1", { exact: true })).toBeVisible();
  await expect
    .element(
      screen
        .getByRole("region", { name: "AGENTS.md details" })
        .getByText("Inherited from available · remote", { exact: true }),
    )
    .toBeVisible();
  await expect.element(screen.getByText("Sections: Shared", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Next lines" }));
  await expect.element(screen.getByText("Inherited instruction.", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByText("Share sections of this file…", { exact: true }));
  await expect.element(screen.getByRole("checkbox", { name: "Local", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("checkbox", { name: /Inherited/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^CLAUDE.md.*Global/ }));
  await expect.element(screen.getByText("Global instructions.", { exact: true })).toBeVisible();
});

it.each(["/work/proj/", "C:\\work\\proj\\"])(
  "uses the full compact project label for a trailing separator in %s",
  async (cwd) => {
    setup("project");
    state.projectPath = cwd;
    await using screen = await render(
      <RegistryProvider>
        <AgentFileSyncSettings />
      </RegistryProvider>,
    );
    const selector = screen.getByRole("combobox", { name: "Environment", exact: true });
    await expect.element(selector).toHaveTextContent("source · work/proj");
    await userEvent.click(selector);
    await expect
      .element(screen.getByRole("option", { name: "source · work/proj", exact: true }))
      .toBeVisible();
  },
);

it("shows sharing on the global skill without attributing it to the project copy", async () => {
  setup("project");
  await using screen = await render(
    <RegistryProvider>
      <AgentFileSyncSettings />
    </RegistryProvider>,
  );
  await expect
    .element(screen.getByRole("button", { name: /^Review.*Global.*Shared with 1/ }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /Project review.*Shared with/ }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^Review.*Global/ }));
  await expect.element(screen.getByText("Shared with available", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show where this file comes from" }));
  await expect.element(screen.getByText("Local file", { exact: true })).toBeVisible();
  await userEvent.type(
    screen.getByRole("textbox", { name: "Find skills or instructions" }),
    "CLAUDE",
  );
  await expect.element(screen.getByText("Global instructions.", { exact: true })).toBeVisible();
});

it("keeps a missing shared skill visible so its destination can be managed", async () => {
  setup("missing");
  await using screen = await render(
    <RegistryProvider>
      <AgentFileSyncSettings />
    </RegistryProvider>,
  );
  await expect.element(screen.getByRole("button", { name: /^review.*Unavailable/ })).toBeVisible();
  await expect.element(screen.getByText("Shared with available", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Stop sharing" })).toBeEnabled();
  await expect
    .element(screen.getByText("Share this skill…", { exact: true }))
    .not.toBeInTheDocument();
});

it("refreshes the selected skill text and its supporting-file list", async () => {
  setup();
  await using screen = await render(
    <RegistryProvider>
      <AgentFileSyncSettings />
    </RegistryProvider>,
  );
  await expect.element(screen.getByText("Check changes.", { exact: true })).toBeVisible();
  state.skillText = "# Review\nUpdated review.";
  state.extraFile = true;
  await userEvent.click(screen.getByRole("button", { name: "Refresh files" }));
  await expect.element(screen.getByText("Updated review.", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("combobox", { name: "Skill file" }));
  await expect.element(screen.getByRole("option", { name: "notes.txt" })).toBeVisible();
});

it("applies explicit pause and stop after automatic sync advances the displayed generation", async () => {
  setup();
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <AgentFileSyncSettings />
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("Shared with available", { exact: true })).toBeVisible();
  state.serverGeneration = 1;
  await userEvent.click(screen.getByRole("button", { name: "Pause", exact: true }));
  await expect.element(screen.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  state.serverGeneration = 2;
  await userEvent.click(screen.getByRole("button", { name: "Stop sharing", exact: true }));
  await expect
    .element(screen.getByText("Shared with available", { exact: true }))
    .not.toBeInTheDocument();
});

it("keeps browsing within the header’s environment scope while allowing sharing to other environments", async () => {
  setup("environment");
  await using screen = await render(
    <RegistryProvider>
      <AgentFileSyncSettings />
    </RegistryProvider>,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Environment", exact: true }));
  await expect.element(screen.getByRole("option", { name: "source", exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("option", { name: "available", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("option", { name: "source", exact: true }));
  await userEvent.click(screen.getByText("Share this skill…", { exact: true }));
  await expect
    .element(screen.getByRole("checkbox", { name: "available", exact: true }))
    .toBeVisible();
});
