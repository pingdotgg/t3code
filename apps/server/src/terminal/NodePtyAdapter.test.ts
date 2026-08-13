import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

const spawn = vi.fn(() => ({
  pid: 42,
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("@lydell/node-pty", () => ({ spawn }));

const testLayer = NodePtyAdapter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(HostProcessPlatform, "win32"),
      Layer.succeed(HostProcessArchitecture, "x64"),
    ),
  ),
);

it.effect("spawns through the public adapter with the provided host references", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "powershell.exe",
      args: ["-NoLogo"],
      cwd: "C:\\workspace",
      cols: 120,
      rows: 40,
      env: {},
    });

    assert.equal(process.pid, 42);
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      ["-NoLogo"],
      {
        cwd: "C:\\workspace",
        cols: 120,
        rows: 40,
        env: { TERM: "xterm-256color" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves a caller-provided TERM in the spawn env on win32", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    yield* adapter.spawn({
      shell: "powershell.exe",
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: { TERM: "xterm-direct" },
    });

    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      [],
      {
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: { TERM: "xterm-direct" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("resolves the spawn helper from the platform package", () =>
  Effect.gen(function* () {
    const wrapperPackageJsonPath =
      "/Applications/T3.app/Contents/Resources/app.asar/node_modules.asar/@lydell/node-pty/package.json";
    const packedHelperPath =
      "/Applications/T3.app/Contents/Resources/app.asar/node_modules.asar/@lydell/node-pty-darwin-arm64/spawn-helper";
    const resolve = vi.fn((request: string) => {
      if (request === "@lydell/node-pty/package.json") return wrapperPackageJsonPath;
      if (request === "@lydell/node-pty-darwin-arm64/spawn-helper") return packedHelperPath;
      throw new Error(`Unexpected module request: ${request}`);
    });
    const createRequire = vi.fn((_filename: string | URL) => ({ resolve }));

    const helperPath = yield* NodePtyAdapter.resolveNodePtySpawnHelperPath(createRequire);

    assert.equal(
      helperPath,
      "/Applications/T3.app/Contents/Resources/app.asar.unpacked/node_modules.asar.unpacked/@lydell/node-pty-darwin-arm64/spawn-helper",
    );
    assert.deepEqual(createRequire.mock.calls[1], [wrapperPackageJsonPath]);
    assert.deepEqual(resolve.mock.calls, [
      ["@lydell/node-pty/package.json"],
      ["@lydell/node-pty-darwin-arm64/spawn-helper"],
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcessPlatform, "darwin"),
        Layer.succeed(HostProcessArchitecture, "arm64"),
      ),
    ),
  ),
);

it.effect("preserves an already-unpacked spawn helper path", () =>
  Effect.gen(function* () {
    const wrapperPackageJsonPath =
      "/Applications/T3.app/Contents/Resources/app.asar.unpacked/node_modules.asar.unpacked/@lydell/node-pty/package.json";
    const unpackedHelperPath =
      "/Applications/T3.app/Contents/Resources/app.asar.unpacked/node_modules.asar.unpacked/@lydell/node-pty-darwin-arm64/spawn-helper";
    const resolve = vi.fn((request: string) => {
      if (request === "@lydell/node-pty/package.json") return wrapperPackageJsonPath;
      if (request === "@lydell/node-pty-darwin-arm64/spawn-helper") return unpackedHelperPath;
      throw new Error(`Unexpected module request: ${request}`);
    });
    const createRequire = vi.fn((_filename: string | URL) => ({ resolve }));

    const helperPath = yield* NodePtyAdapter.resolveNodePtySpawnHelperPath(createRequire);

    assert.equal(helperPath, unpackedHelperPath);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcessPlatform, "darwin"),
        Layer.succeed(HostProcessArchitecture, "arm64"),
      ),
    ),
  ),
);

it.effect("reports native module load failures as structured startup defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native binding could not be loaded");
    const exit = yield* NodePtyAdapter.make(() => Promise.reject(cause)).pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.hasDies(exit.cause));
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, NodePtyAdapter.NodePtyModuleLoadError);
      assert.deepInclude(error, {
        _tag: "NodePtyModuleLoadError",
        platform: "win32",
        architecture: "x64",
      });
      assert.equal(error.message, "Failed to load node-pty for win32-x64.");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
        Layer.succeed(HostProcessArchitecture, "x64"),
      ),
    ),
  ),
);
