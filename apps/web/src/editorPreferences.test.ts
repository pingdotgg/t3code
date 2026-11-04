import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { assert, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  terminalAllowed: new Set<string>(),
  run: vi.fn(),
  getPreference: vi.fn(),
  setPreference: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("./state/shell", () => ({ shellEnvironment: { openInEditor: "openInEditor" } }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("./state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    (scope === AuthOrchestrationOperateScope && state.allowed.has(environmentId)) ||
    (scope === AuthTerminalOperateScope && state.terminalAllowed.has(environmentId)),
}));
vi.mock("./hooks/useLocalStorage", () => ({
  getLocalStorageItem: state.getPreference,
  setLocalStorageItem: state.setPreference,
  useLocalStorage: vi.fn(),
}));

import { useOpenInPreferredEditor } from "./editorPreferences";
import { registerTerminalEditorHost } from "./terminalEditorHost";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");

beforeEach(() => {
  state.allowed.clear();
  state.terminalAllowed.clear();
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.getPreference.mockReset().mockReturnValue(null);
  state.setPreference.mockReset();
});

it("does not use another environment's grant or change preferences when denied", async () => {
  state.allowed.add(primary);
  const open = useOpenInPreferredEditor(secondary, ["vscode"]);
  const result = await open("/work/readme.md");
  assert(result._tag === "Failure");
  const error = Cause.squash(result.cause);
  expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
  expect(error).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
  expect(state.run).not.toHaveBeenCalled();
  expect(state.getPreference).not.toHaveBeenCalled();
  expect(state.setPreference).not.toHaveBeenCalled();
});

it("checks revocation and regrant when a retained editor callback is invoked", async () => {
  state.allowed.add(secondary);
  const open = useOpenInPreferredEditor(secondary, ["vscode"]);
  state.allowed.delete(secondary);
  expect((await open("/work/readme.md:5"))._tag).toBe("Failure");
  expect(state.run).not.toHaveBeenCalled();

  state.allowed.add(secondary);
  expect(await open("/work/readme.md:5")).toMatchObject({ _tag: "Success", value: "vscode" });
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId: secondary,
    input: { cwd: "/work/readme.md:5", editor: "vscode" },
  });
  expect(state.setPreference).toHaveBeenCalledTimes(1);
});

it("runs a terminal editor in the foreground thread of the same environment", async () => {
  state.allowed.add(primary);
  state.terminalAllowed.add(primary);
  state.getPreference.mockReturnValue("neovim");
  const hostOpen = vi.fn().mockResolvedValue(undefined);
  using _host = {
    [Symbol.dispose]: registerTerminalEditorHost({ environmentId: primary, open: hostOpen }),
  };

  const result = await useOpenInPreferredEditor(primary, ["vscode", "neovim"])("/work/a.ts:5:2");

  assert(result._tag === "Success");
  expect(result.value).toBe("neovim");
  expect(hostOpen).toHaveBeenCalledWith("nvim '+call cursor(5,2)' -- '/work/a.ts'");
  expect(state.run).not.toHaveBeenCalled();
});

it.each([
  { name: "no foreground thread", hostEnvironment: null, terminalAllowed: true },
  { name: "a thread on another environment", hostEnvironment: secondary, terminalAllowed: true },
  { name: "no terminal access", hostEnvironment: primary, terminalAllowed: false },
])("falls back without changing the preference with $name", async (input) => {
  state.allowed.add(primary);
  if (input.terminalAllowed) state.terminalAllowed.add(primary);
  state.getPreference.mockReturnValue("neovim");
  const hostOpen = vi.fn();
  using _host = {
    [Symbol.dispose]:
      input.hostEnvironment === null
        ? () => {}
        : registerTerminalEditorHost({ environmentId: input.hostEnvironment, open: hostOpen }),
  };

  const result = await useOpenInPreferredEditor(primary, ["neovim", "zed"])("/work/a.ts");

  assert(result._tag === "Success");
  expect(result.value).toBe("zed");
  expect(hostOpen).not.toHaveBeenCalled();
  expect(state.run).toHaveBeenCalledWith({
    environmentId: primary,
    input: { cwd: "/work/a.ts", editor: "zed" },
  });
  expect(state.setPreference).not.toHaveBeenCalled();
});
