import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { NewProjectScriptInput } from "../projectScriptEditor";

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

let root: Root;
let container: HTMLDivElement;

async function renderSettings(
  keybindings: ResolvedKeybindingsConfig,
  scope: "project" | "environment" = "project",
) {
  let settings: ProjectScriptSettings | undefined;
  await act(async () =>
    root.render(
      <Probe
        targets={[
          {
            environmentId,
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              defaultProjectScripts: scope === "environment" ? [lint] : [],
            },
            keybindings,
            ...(scope === "project"
              ? { project: { id: ProjectId.make("project"), scripts: [lint] } }
              : {}),
          },
        ]}
        onResult={(next) => (settings = next)}
      />,
    ),
  );
  return settings!;
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  for (const command of Object.values(commands)) {
    command.mockResolvedValue(AsyncResult.success(undefined));
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("useProjectScriptSettings", () => {
  it.each(["project", "environment"] as const)(
    "preserves the shortcut for %s action name and command edits",
    async (scope) => {
      const { submit } = await renderSettings(lintBinding, scope);
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

  it("saves a recorded action shortcut", async () => {
    const { submit } = await renderSettings([]);

    const result = await submitInAct(submit, { keybinding: "mod+shift+k" });

    expect(result._tag).toBe("Success");
    expect(commands.upsertKeybinding).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ key: "mod+shift+k", command: "script.lint.run" }),
    });
  });

  it("removes a cleared action shortcut", async () => {
    const { submit } = await renderSettings(lintBinding);

    const result = await submitInAct(submit, { keybinding: null });

    expect(result._tag).toBe("Success");
    expect(commands.removeKeybinding).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ key: "mod+shift+k", command: "script.lint.run" }),
    });
    expect(commands.upsertKeybinding).not.toHaveBeenCalled();
  });

  it("replaces an explicitly changed action shortcut", async () => {
    const { submit } = await renderSettings(lintBinding);

    const result = await submitInAct(submit, { keybinding: "mod+shift+l" });

    expect(result._tag).toBe("Success");
    expect(commands.upsertKeybinding).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        command: "script.lint.run",
        key: "mod+shift+l",
        replace: { command: "script.lint.run", key: "mod+shift+k" },
      },
    });
    expect(commands.removeKeybinding).not.toHaveBeenCalled();
  });

  it("removes the shortcut when its action is deleted", async () => {
    const { persist } = await renderSettings(lintBinding);

    await act(async () => {
      expect((await persist(() => []))._tag).toBe("Success");
    });

    expect(commands.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { patch: { projectSettingsOverrides: { project: { defaultProjectScripts: [] } } } },
    });
    expect(commands.removeKeybinding).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { key: "mod+shift+k", command: "script.lint.run" },
    });
    expect(commands.upsertKeybinding).not.toHaveBeenCalled();
  });
});
