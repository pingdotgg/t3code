import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { NewProjectScriptInput } from "../projectScriptEditor";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { droppedSettingKeysAtom, droppedSettingKeysFor } from "./droppedSettingKeys";
import { resolveUnsupportedSettingKeys } from "./scopedSettings";

const commands = vi.hoisted(() => ({
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
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useOptionalSettingsScope: (() => ({
    environments: [{ environmentId, serverConfig: { environment: { serverVersion: "old" } } }],
  })) as never,
}));

import { useProjectScriptSettings } from "./useProjectScriptSettings";

const environmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
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
const input = (keybinding: string | null): NewProjectScriptInput => ({
  name: lint.name,
  command: lint.command,
  icon: lint.icon,
  runOnWorktreeCreate: false,
  waitForSetup: false,
  runOnSettle: false,
  keybinding,
  previewUrl: null,
  autoOpenPreview: false,
});

type ProjectScriptSettings = ReturnType<typeof useProjectScriptSettings>;

function Probe(props: {
  keybindings: ResolvedKeybindingsConfig;
  projectScope: boolean;
  onResult: (settings: ProjectScriptSettings) => void;
}) {
  props.onResult(
    useProjectScriptSettings([
      {
        environmentId,
        settings: DEFAULT_SERVER_SETTINGS,
        keybindings: props.keybindings,
        ...(props.projectScope ? { project: { id: projectId, scripts: [lint] } } : {}),
      },
    ]),
  );
  return null;
}

let root: Root;
let container: HTMLDivElement;

async function renderSettings(keybindings: ResolvedKeybindingsConfig, projectScope = true) {
  let settings: ProjectScriptSettings | undefined;
  await act(async () =>
    root.render(
      <Probe
        keybindings={keybindings}
        projectScope={projectScope}
        onResult={(next) => (settings = next)}
      />,
    ),
  );
  return settings!;
}

async function submitInAct(submit: ProjectScriptSettings["submit"], keybinding: string | null) {
  let result: Awaited<ReturnType<typeof submit>> | undefined;
  await act(async () => {
    result = await submit(lint.id, input(keybinding));
  });
  return result!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  appAtomRegistry.set(droppedSettingKeysAtom, new Map());
  for (const command of Object.values(commands)) {
    command.mockResolvedValue(AsyncResult.success(undefined));
  }
  commands.updateSettings.mockImplementation(
    ({ input }: { input: { patch: ServerSettingsPatch } }) =>
      AsyncResult.success({ ...DEFAULT_SERVER_SETTINGS, ...input.patch }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  appAtomRegistry.set(droppedSettingKeysAtom, new Map());
});

describe("useProjectScriptSettings", () => {
  it.each([
    { scope: "project", dropped: "array" },
    { scope: "project", dropped: "runOnSettle" },
    { scope: "environment", dropped: "runOnSettle" },
  ])(
    "reports a dropped $dropped at $scope scope without changing shortcuts",
    async ({ scope, dropped }) => {
      const projectScope = scope === "project";
      commands.updateSettings.mockImplementation(
        ({ input: { patch } }: { input: { patch: ServerSettingsPatch } }) => {
          if (dropped === "array") return AsyncResult.success(DEFAULT_SERVER_SETTINGS);
          const requested = projectScope
            ? patch.projectSettingsOverrides?.[projectId]?.defaultProjectScripts
            : patch.defaultProjectScripts;
          const saved = requested!.map(({ runOnSettle: _runOnSettle, ...script }) => script);
          return AsyncResult.success({
            ...DEFAULT_SERVER_SETTINGS,
            ...(projectScope
              ? { projectSettingsOverrides: { [projectId]: { defaultProjectScripts: saved } } }
              : { defaultProjectScripts: saved }),
          });
        },
      );
      const { submit } = await renderSettings([], projectScope);
      let result: Awaited<ReturnType<typeof submit>> | undefined;

      await act(async () => {
        result = await submit(null, {
          ...input("mod+shift+k"),
          runOnSettle: dropped === "runOnSettle",
        });
      });

      expect(commands.updateSettings).toHaveBeenCalledOnce();
      const requested = [
        ...(projectScope ? [lint] : []),
        {
          ...lint,
          id: projectScope ? "lint-2" : "lint",
          ...(dropped === "runOnSettle" ? { runOnSettle: true } : {}),
        },
      ];
      expect(commands.updateSettings).toHaveBeenCalledWith({
        environmentId,
        input: {
          patch: projectScope
            ? { projectSettingsOverrides: { [projectId]: { defaultProjectScripts: requested } } }
            : { defaultProjectScripts: requested },
        },
      });
      expect.soft(result?._tag).toBe("Failure");
      expect.soft(commands.upsertKeybinding).not.toHaveBeenCalled();
      expect(commands.removeKeybinding).not.toHaveBeenCalled();
      const unsupported = resolveUnsupportedSettingKeys(
        undefined,
        droppedSettingKeysFor(appAtomRegistry.get(droppedSettingKeysAtom), environmentId, "old"),
      );
      expect(unsupported).toEqual(
        new Set(dropped === "array" ? ["projectSettingsOverrides.defaultProjectScripts"] : []),
      );
    },
  );

  it("saves a recorded action shortcut", async () => {
    const { submit } = await renderSettings([]);

    const result = await submitInAct(submit, "mod+shift+k");

    expect(result._tag).toBe("Success");
    expect(commands.upsertKeybinding).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ key: "mod+shift+k", command: "script.lint.run" }),
    });
  });

  it("removes a cleared action shortcut", async () => {
    const { submit } = await renderSettings(lintBinding);

    const result = await submitInAct(submit, null);

    expect(result._tag).toBe("Success");
    expect(commands.removeKeybinding).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ key: "mod+shift+k", command: "script.lint.run" }),
    });
    expect(commands.upsertKeybinding).not.toHaveBeenCalled();
  });
});
