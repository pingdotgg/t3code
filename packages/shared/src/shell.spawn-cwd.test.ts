// @effect-diagnostics nodeBuiltinImport:off - exercise native executable lookup against controlled Windows paths.
import * as NodeFS from "node:fs";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "./hostProcess.ts";
import { resolveSpawnCommand } from "./shell.ts";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, statSync: vi.fn(original.statSync) };
});

afterEach(() => vi.restoreAllMocks());

const mockExecutables = (paths: ReadonlyArray<string>) =>
  vi.mocked(NodeFS.statSync).mockImplementation((path) => {
    if (!paths.includes(String(path))) throw new Error("ENOENT");
    return { isFile: () => true } as NodeFS.Stats;
  });

it.effect("resolves relative Windows commands from the child directory", () =>
  Effect.gen(function* () {
    mockExecutables(["C:\\project\\bin\\tool.cmd"]);
    const result = yield* resolveSpawnCommand(".\\bin\\tool", ["hello & goodbye"], {
      cwd: "C:\\project",
      env: { PATH: "", PATHEXT: ".EXE;.CMD" },
    });
    expect(result).toEqual({
      command: '^"C:\\project\\bin\\tool.cmd^"',
      args: ['^"hello^ ^&^ goodbye^"'],
      shell: true,
    });
  }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
);

it.effect("resolves relative PATH entries separately for each child directory", () =>
  Effect.gen(function* () {
    mockExecutables([
      "C:\\one\\node_modules\\.bin\\tool.exe",
      "C:\\two\\node_modules\\.bin\\tool.cmd",
    ]);
    const env = { PATH: "node_modules\\.bin", PATHEXT: ".EXE;.CMD" };
    const first = yield* resolveSpawnCommand("tool", [], { cwd: "C:\\one", env });
    const second = yield* resolveSpawnCommand("tool", [], { cwd: "C:\\two", env });
    expect(first).toEqual({
      command: "C:\\one\\node_modules\\.bin\\tool.exe",
      args: [],
      shell: false,
    });
    expect(second).toEqual({
      command: '^"C:\\two\\node_modules\\.bin\\tool.cmd^"',
      args: [],
      shell: true,
    });
  }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
);

it.effect("keeps absolute Windows executable paths independent of the child directory", () =>
  Effect.gen(function* () {
    mockExecutables(["C:\\tools\\tool.exe"]);
    const result = yield* resolveSpawnCommand("C:\\tools\\tool.exe", ["plain"], {
      cwd: "D:\\project",
      env: { PATH: "", PATHEXT: ".EXE;.CMD" },
    });
    expect(result).toEqual({ command: "C:\\tools\\tool.exe", args: ["plain"], shell: false });
  }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
);
