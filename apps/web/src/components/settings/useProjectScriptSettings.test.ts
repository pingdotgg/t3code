import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const rpc = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: hooks.useRef,
  useState: hooks.useState,
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/server", () => ({ serverEnvironment: rpc }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { useProjectScriptSettings } from "./useProjectScriptSettings";

const environmentId = EnvironmentId.make("shortcut-test");
const input = {
  name: "Test",
  command: "vp test",
  icon: "test" as const,
  runOnWorktreeCreate: false,
  waitForSetup: false,
  runOnSettle: false,
  previewUrl: null,
  autoOpenPreview: false,
};
const script = {
  id: "test",
  name: input.name,
  command: input.command,
  icon: input.icon,
  runOnWorktreeCreate: false,
};
const previous = { command: "script.test.run", key: "mod+shift+t" };
function render(projectScoped = true) {
  hooks.beginRender();
  return useProjectScriptSettings([
    {
      environmentId,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultProjectScripts: projectScoped ? [] : [script],
      },
      keybindings: [
        {
          command: "script.test.run",
          shortcut: {
            key: "t",
            modKey: true,
            shiftKey: true,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
          },
        },
      ],
      ...(projectScoped ? { project: { id: ProjectId.make("project"), scripts: [script] } } : {}),
    },
  ]);
}

describe("project action shortcut edits", () => {
  beforeEach(() => {
    hooks.reset();
    for (const command of Object.values(rpc))
      command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  });
  it.each([
    { projectScoped: true, edit: { command: "vp test run" } },
    { projectScoped: true, edit: { name: "Renamed test" } },
    { projectScoped: false, edit: { command: "vp test run" } },
    { projectScoped: false, edit: { name: "Renamed test" } },
  ])("preserves an omitted shortcut ($projectScoped, $edit)", async ({ projectScoped, edit }) => {
    expect((await render(projectScoped).submit("test", { ...input, ...edit }))._tag).toBe(
      "Success",
    );
    expect(rpc.updateSettings).toHaveBeenCalledOnce();
    const patch = rpc.updateSettings.mock.calls[0]?.[0].input.patch;
    const scripts = projectScoped
      ? patch.projectSettingsOverrides.project.defaultProjectScripts
      : patch.defaultProjectScripts;
    expect(scripts).toEqual([expect.objectContaining({ id: "test", ...edit })]);
    expect(rpc.removeKeybinding).not.toHaveBeenCalled();
    expect(rpc.upsertKeybinding).not.toHaveBeenCalled();
  });
  it("clears an explicitly null shortcut", async () => {
    await render().submit("test", { ...input, keybinding: null });
    expect(rpc.removeKeybinding).toHaveBeenCalledWith({ environmentId, input: previous });
    expect(rpc.upsertKeybinding).not.toHaveBeenCalled();
  });
  it("replaces an explicitly changed shortcut", async () => {
    await render().submit("test", { ...input, keybinding: "mod+shift+y" });
    expect(rpc.upsertKeybinding).toHaveBeenCalledWith({
      environmentId,
      input: { command: previous.command, key: "mod+shift+y", replace: previous },
    });
    expect(rpc.removeKeybinding).not.toHaveBeenCalled();
  });
  it("removes the shortcut when its action is deleted", async () => {
    await render().persist(() => []);
    expect(rpc.removeKeybinding).toHaveBeenCalledWith({ environmentId, input: previous });
  });
});
