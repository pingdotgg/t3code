import { act, render } from "../../../test/render";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import type { NewProjectScriptInput } from "../projectScriptEditor";

const commands = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
}));
const state = vi.hoisted(() => ({ projects: [] as unknown[] }));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: "updateSettings",
      upsertKeybinding: "upsertKeybinding",
      removeKeybinding: "removeKeybinding",
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: keyof typeof commands) => commands[command]) as never,
}));

import { useProjectScriptSettings } from "./useProjectScriptSettings";

const environmentId = EnvironmentId.make("remote");
const lint: ProjectScript = {
  id: "lint",
  name: "Lint",
  command: "vp lint",
  icon: "lint",
  runOnWorktreeCreate: false,
};
const lintBinding: ResolvedKeybindingsConfig = [
  {
    command: "script.lint.run",
    shortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    },
  },
];
const input: NewProjectScriptInput = {
  name: lint.name,
  command: lint.command,
  icon: lint.icon,
  runOnWorktreeCreate: false,
  waitForSetup: false,
  runOnSettle: false,
  previewUrl: null,
  autoOpenPreview: false,
};

type ProjectScriptSettings = ReturnType<typeof useProjectScriptSettings>;

function Probe(props: {
  targets: Parameters<typeof useProjectScriptSettings>[0];
  onResult: (settings: ProjectScriptSettings) => void;
}) {
  props.onResult(useProjectScriptSettings(props.targets));
  return null;
}

async function renderSettings(
  keybindings: ResolvedKeybindingsConfig,
  scope: "project" | "environment" = "project",
  settingsPatch: Partial<ServerSettings> = {},
) {
  let settings: ProjectScriptSettings | undefined;
  const screen = await render(
    <Probe
      targets={[
        {
          environmentId,
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            defaultProjectScripts: scope === "environment" ? [lint] : [],
            ...settingsPatch,
          },
          keybindings,
          ...(scope === "project"
            ? { project: { id: ProjectId.make("project"), scripts: [lint] } }
            : {}),
        },
      ]}
      onResult={(next) => (settings = next)}
    />,
  );
  return {
    ...screen,
    get settings() {
      return settings!;
    },
  };
}

async function submitInAct(
  submit: ProjectScriptSettings["submit"],
  changes: Partial<NewProjectScriptInput>,
) {
  let result: Awaited<ReturnType<typeof submit>> | undefined;
  await act(async () => {
    result = await submit(lint.id, { ...input, ...changes });
  });
  return result!;
}
function setup() {
  vi.clearAllMocks();
  state.projects = [];
  for (const command of Object.values(commands))
    command.mockResolvedValue(AsyncResult.success(undefined));
}

describe("useProjectScriptSettings", () => {
  it.each(["project", "environment"] as const)(
    "preserves the shortcut for %s action name and command edits",
    async (scope) => {
      setup();
      await using screen = await renderSettings(lintBinding, scope);
      const { submit } = screen.settings;
      const changes = { name: "Lint and fix", command: "vp lint --fix" };

      const result = await submitInAct(submit, changes);

      expect(result._tag).toBe("Success");
      const scripts = [expect.objectContaining({ id: lint.id, ...changes })];
      expect(commands.updateSettings).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: {
          patch:
            scope === "project"
              ? { projectSettingsOverrides: { project: { defaultProjectScripts: scripts } } }
              : { defaultProjectScripts: scripts },
        },
      });
      expect(commands.removeKeybinding).not.toHaveBeenCalled();
      expect(commands.upsertKeybinding).not.toHaveBeenCalled();
    },
  );

  it("keeps a default action's shortcut when deleting it while a legacy project override still lists it", async () => {
    setup();
    const retaining = ProjectId.make("retaining");
    state.projects = [{ id: retaining, environmentId, scripts: [] }];
    await using screen = await renderSettings(lintBinding, "environment", {
      projectSettingsFolded: false,
      projectScriptOverrides: { [retaining]: [lint] },
    });

    await act(async () => {
      await screen.settings.persist(
        (current) => current.filter((script) => script.id !== lint.id),
        lint.id,
        null,
      );
    });

    expect(commands.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { patch: { defaultProjectScripts: [] } },
    });
    expect(commands.removeKeybinding).not.toHaveBeenCalled();
  });
});
