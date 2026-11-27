import { act, render } from "../../../test/render";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import type { NewProjectScriptInput } from "../projectScriptEditor";

const commands = vi.hoisted(() => ({
  readSettings: vi.fn(),
  updateSettings: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      readSettings: "readSettings",
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

const settingsFor = (scope: "project" | "environment"): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  defaultProjectScripts: scope === "environment" ? [lint] : [],
});

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
) {
  let settings: ProjectScriptSettings | undefined;
  const screen = await render(
    <Probe
      targets={[
        {
          environmentId,
          settings: settingsFor(scope),
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
  for (const command of Object.values(commands))
    command.mockResolvedValue(AsyncResult.success(undefined));
}

describe("useProjectScriptSettings", () => {
  it("keeps consecutive imports and adds when the streamed settings have not caught up", async () => {
    setup();
    const projectId = ProjectId.make("project");
    let stored: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    };
    commands.readSettings.mockImplementation(async () => AsyncResult.success(stored));
    commands.updateSettings.mockImplementation(
      async ({ input }: { input: { patch: ServerSettingsPatch } }) => {
        stored = applyServerSettingsPatch(stored, input.patch);
        return AsyncResult.success(stored);
      },
    );
    await using screen = await renderSettings([]);
    const build = { ...input, name: "Build", command: "vp build" };
    const check = { ...input, name: "Check", command: "vp check" };
    const format = { ...input, name: "Format", command: "vp fmt" };
    for (const action of [build, check, build]) {
      await act(async () => {
        const result = await screen.settings.importScript(action);
        expect(result._tag).toBe("Success");
      });
    }
    await act(async () => {
      const result = await screen.settings.submit(null, format);
      expect(result._tag).toBe("Success");
    });

    expect(stored.projectSettingsOverrides[projectId]).toMatchObject({
      defaultAutoPull: true,
      defaultProjectScripts: [lint, build, check, format].map(({ name, command }) =>
        expect.objectContaining({ name, command }),
      ),
    });
  });

  it.each(["project", "environment"] as const)(
    "preserves the shortcut for %s action name and command edits",
    async (scope) => {
      setup();
      commands.readSettings.mockResolvedValue(AsyncResult.success(settingsFor(scope)));
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
              ? { projectScriptOverrides: { project: scripts } }
              : { defaultProjectScripts: scripts },
        },
      });
      expect(commands.removeKeybinding).not.toHaveBeenCalled();
      expect(commands.upsertKeybinding).not.toHaveBeenCalled();
    },
  );
});
