// @effect-diagnostics nodeBuiltinImport:off
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

const mockExecutables = (paths: Set<string>) =>
  vi.mocked(NodeFS.statSync).mockImplementation((path) => {
    if (!paths.has(String(path))) throw new Error("ENOENT");
    return { isFile: () => true } as NodeFS.Stats;
  });

it.effect("reuses a Windows PATH scan while validating the selected executable", () =>
  Effect.gen(function* () {
    const paths = new Set(["C:\\tools\\cache-probe.exe"]);
    const stat = mockExecutables(paths);
    const env = { PATH: "C:\\missing;C:\\tools", PATHEXT: ".EXE;.CMD" };
    const first = yield* resolveSpawnCommand("cache-probe", ["one"], { env });
    expect(first.command).toBe("C:\\tools\\cache-probe.exe");
    expect(stat.mock.calls.length).toBeGreaterThan(1);
    stat.mockClear();
    const second = yield* resolveSpawnCommand("cache-probe", ["two"], { env });
    expect(second).toEqual({ command: first.command, args: ["two"], shell: false });
    expect(stat.mock.calls.map(([path]) => path)).toEqual([first.command]);

    paths.delete(first.command);
    paths.add("C:\\missing\\cache-probe.cmd");
    const replacement = yield* resolveSpawnCommand("cache-probe", [], { env });
    expect(replacement.shell).toBe(true);
    expect(replacement.command).toContain("cache-probe.cmd");
  }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
);

it.effect("expires Windows spawn scans so newly preferred executables are discovered", () =>
  Effect.gen(function* () {
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const paths = new Set(["C:\\second\\expiring-probe.exe"]);
    mockExecutables(paths);
    const env = { PATH: "C:\\first;C:\\second", PATHEXT: ".EXE" };
    expect((yield* resolveSpawnCommand("expiring-probe", [], { env })).command).toBe(
      "C:\\second\\expiring-probe.exe",
    );
    paths.add("C:\\first\\expiring-probe.exe");
    now.mockReturnValue(11_001);
    expect((yield* resolveSpawnCommand("expiring-probe", [], { env })).command).toBe(
      "C:\\first\\expiring-probe.exe",
    );
  }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
);

it.effect("does not cache missing commands or share scans across PATH and PATHEXT", () =>
  Effect.gen(function* () {
    const paths = new Set<string>();
    mockExecutables(paths);
    const env = { PATH: "C:\\one", PATHEXT: ".EXE" };
    expect((yield* resolveSpawnCommand("environment-probe", [], { env })).command).toBe(
      "environment-probe",
    );
    paths.add("C:\\one\\environment-probe.exe");
    expect((yield* resolveSpawnCommand("environment-probe", [], { env })).command).toBe(
      "C:\\one\\environment-probe.exe",
    );
    paths.add("C:\\two\\environment-probe.exe");
    expect(
      (yield* resolveSpawnCommand("environment-probe", [], { env: { ...env, PATH: "C:\\two" } }))
        .command,
    ).toBe("C:\\two\\environment-probe.exe");
    paths.add("C:\\one\\environment-probe.cmd");
    expect(
      (yield* resolveSpawnCommand("environment-probe", [], {
        env: { ...env, PATHEXT: ".CMD;.EXE" },
      })).shell,
    ).toBe(true);
  }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
);
