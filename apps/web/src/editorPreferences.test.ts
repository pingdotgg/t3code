import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { assert, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  run: vi.fn(),
  getPreference: vi.fn(),
  setPreference: vi.fn(),
  readConnection: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("./state/shell", () => ({ shellEnvironment: { openInEditor: "openInEditor" } }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("./state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.allowed.has(environmentId),
  readPreparedConnection: state.readConnection,
}));
vi.mock("./hooks/useLocalStorage", () => ({
  getLocalStorageItem: state.getPreference,
  setLocalStorageItem: state.setPreference,
  useLocalStorage: vi.fn(),
}));

import { useOpenInPreferredEditor } from "./editorPreferences";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");

beforeEach(() => {
  state.allowed.clear();
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.getPreference.mockReset().mockReturnValue(null);
  state.setPreference.mockReset();
  state.readConnection.mockReset().mockReturnValue(null);
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

it("opens in the IDE with a position, honors revocation, and reports native failures", async () => {
  const openFile = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("window", {
    location: { origin: "http://localhost:6071" },
    t3JetBrains: { protocolVersion: 1, projectPath: "/work", openFile },
  });
  try {
    state.readConnection.mockReturnValue({
      httpBaseUrl: "http://localhost:6071",
      target: { _tag: "PrimaryConnectionTarget" },
    });
    state.allowed.add(primary);
    const open = useOpenInPreferredEditor(primary, []);
    expect(await open("/work/source.ts:12:4")).toMatchObject({
      _tag: "Success",
      value: "webstorm",
    });
    expect(openFile).toHaveBeenCalledExactlyOnceWith({
      path: "/work/source.ts",
      line: 12,
      column: 4,
    });
    state.allowed.delete(primary);
    expect((await open("/work/source.ts:12:4"))._tag).toBe("Failure");
    expect(openFile).toHaveBeenCalledTimes(1);
    state.allowed.add(primary);
    openFile.mockRejectedValue(new Error("File not found."));
    const failed = await open("/work/missing.ts");
    assert(failed._tag === "Failure");
    expect(Cause.squash(failed.cause)).toMatchObject({ message: "File not found." });
    expect(state.run).not.toHaveBeenCalled();
    expect(state.setPreference).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(["read", "write"] as const)(
  "opens an available editor when its preference %s fails",
  async (operation) => {
    state.allowed.add(secondary);
    const preference = operation === "read" ? state.getPreference : state.setPreference;
    preference.mockImplementationOnce(() => {
      throw new Error("Preference storage unavailable");
    });
    using _warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const open = useOpenInPreferredEditor(secondary, ["vscode"]);
    await expect(open("/work/readme.md:5")).resolves.toMatchObject({
      _tag: "Success",
      value: "vscode",
    });
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId: secondary,
      input: { cwd: "/work/readme.md:5", editor: "vscode" },
    });
  },
);

it.each([
  ["file:///work/read%20me.md", "/work/read me.md", {}],
  [
    "file://foreign/share/read%20me.md:12#L5",
    String.raw`\\foreign\share\read me.md:12`,
    { line: 5 },
  ],
  ["file:///work/report.txt:12", "/work/report.txt:12", {}],
  ["file:///work/report.txt:12#L5C3", "/work/report.txt:12", { line: 5, column: 3 }],
])(
  "sends a plain exact path for %s to compatible and older servers",
  async (uri, cwd, position) => {
    state.allowed.add(secondary);
    const open = useOpenInPreferredEditor(secondary, ["vscode"]);
    await open(uri);
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId: secondary,
      input: { cwd, position, editor: "vscode" },
    });
  },
);
