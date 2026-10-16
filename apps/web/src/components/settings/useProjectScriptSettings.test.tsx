import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { NewProjectScriptInput } from "../projectScriptEditor";

const commands = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
}));

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: "updateSettings",
    upsertKeybinding: "upsertKeybinding",
    removeKeybinding: "removeKeybinding",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof commands) => commands[command],
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

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
  onResult: (settings: ProjectScriptSettings) => void;
}) {
  props.onResult(
    useProjectScriptSettings([
      {
        environmentId,
        settings: DEFAULT_SERVER_SETTINGS,
        keybindings: props.keybindings,
        project: { id: ProjectId.make("project"), scripts: [lint] },
      },
    ]),
  );
  return null;
}

let renderer: ReactTestRenderer | undefined;

function renderSettings(keybindings: ResolvedKeybindingsConfig) {
  let settings: ProjectScriptSettings | undefined;
  act(() => {
    renderer = create(<Probe keybindings={keybindings} onResult={(next) => (settings = next)} />);
  });
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
  for (const command of Object.values(commands)) {
    command.mockResolvedValue(AsyncResult.success(undefined));
  }
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("useProjectScriptSettings in a browser client", () => {
  it("saves a recorded action shortcut", async () => {
    const { submit } = renderSettings([]);

    const result = await submitInAct(submit, "mod+shift+k");

    expect(result._tag).toBe("Success");
    expect(commands.upsertKeybinding).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ key: "mod+shift+k", command: "script.lint.run" }),
    });
  });

  it("removes a cleared action shortcut", async () => {
    const { submit } = renderSettings(lintBinding);

    const result = await submitInAct(submit, null);

    expect(result._tag).toBe("Success");
    expect(commands.removeKeybinding).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ key: "mod+shift+k", command: "script.lint.run" }),
    });
    expect(commands.upsertKeybinding).not.toHaveBeenCalled();
  });
});
