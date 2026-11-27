import { act, render } from "../../../test/render";
import { EnvironmentId, ProjectId, type ProjectScript } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
  projects: [] as unknown[],
  serverConfig: null as unknown,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => mocks.projects as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: () => "config",
      updateSettings: "updateSettings",
      upsertKeybinding: "upsertKeybinding",
      removeKeybinding: "removeKeybinding",
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("../../rpc/atomRegistry"), async (original) => ({
  ...(await original()),
  appAtomRegistry: { get: () => mocks.serverConfig } as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "updateSettings" | "upsertKeybinding" | "removeKeybinding") =>
    mocks[command]) as never,
}));

import { useProjectScriptEditing } from "./useProjectScriptEditing";

const environmentId = EnvironmentId.make("local");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const testScript: ProjectScript = {
  id: "test",
  name: "Test",
  command: "vp test",
  icon: "test",
  runOnWorktreeCreate: false,
};

describe("useProjectScriptEditing", () => {
  it("gives a new action its own id when another project has one with the same name", async () => {
    vi.clearAllMocks();
    for (const command of [mocks.updateSettings, mocks.upsertKeybinding, mocks.removeKeybinding])
      command.mockResolvedValue(AsyncResult.success(undefined));
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      projectSettingsFolded: true,
      defaultProjectScripts: [],
      projectSettingsOverrides: { [projectA]: { defaultProjectScripts: [testScript] } },
    };
    const project = (id: ProjectId) =>
      ({
        id,
        environmentId,
        workspaceRoot: `/repo/${id}`,
        scripts: [],
      }) as never as EnvironmentProject;
    mocks.projects = [project(projectA), project(projectB)];
    // Project A's Test action runs on Mod+Shift+T.
    mocks.serverConfig = {
      environment: { capabilities: { projectSettingsOverrides: true } },
      keybindings: [
        {
          command: "script.test.run",
          shortcut: {
            key: "t",
            metaKey: false,
            ctrlKey: false,
            shiftKey: true,
            altKey: false,
            modKey: true,
          },
        },
      ],
    };

    let editing: ReturnType<typeof useProjectScriptEditing> | undefined;
    function Probe() {
      editing = useProjectScriptEditing({
        environmentId,
        project: project(projectB),
        scripts: [],
        settings,
      });
      return null;
    }
    await using _screen = await render(<Probe />);

    // Add a Test action to project B with its own shortcut.
    await act(async () => {
      await editing!.saveProjectScript({
        name: "Test",
        command: "bun test",
        icon: "test",
        runOnWorktreeCreate: false,
        waitForSetup: false,
        runOnSettle: false,
        keybinding: "mod+shift+y",
        previewUrl: null,
        autoOpenPreview: false,
      });
    });

    const patch = mocks.updateSettings.mock.calls[0]![0].input.patch;
    const [added] = patch.projectSettingsOverrides[projectB].defaultProjectScripts;
    // Project A keeps Mod+Shift+T: the new shortcut replaces nothing.
    expect(mocks.upsertKeybinding).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { key: "mod+shift+y", command: `script.${added.id}.run` },
    });
    expect(added.id).not.toBe("test");
    expect(mocks.removeKeybinding).not.toHaveBeenCalled();
  });
});
