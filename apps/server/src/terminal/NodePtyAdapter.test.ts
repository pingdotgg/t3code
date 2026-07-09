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

vi.mock("node-pty", () => ({ spawn }));

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
        env: {},
        name: "xterm-color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports native module load failures as structured spawn failures", () =>
  Effect.gen(function* () {
    const cause = new Error("native binding could not be loaded");
    const adapter = yield* NodePtyAdapter.make(() => Promise.reject(cause));
    const exit = yield* adapter
      .spawn({
        shell: "powershell.exe",
        args: ["-NoLogo"],
        cwd: "C:\\workspace",
        cols: 120,
        rows: 40,
        env: {},
      })
      .pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, PtyAdapter.PtySpawnError);
      assert.deepInclude(error, {
        _tag: "PtySpawnError",
        adapter: "node-pty",
        shell: "powershell.exe",
      });
      assert.instanceOf(error.cause, NodePtyAdapter.NodePtyModuleLoadError);
      assert.deepInclude(error.cause, {
        _tag: "NodePtyModuleLoadError",
        platform: "win32",
        architecture: "x64",
        cause,
      });
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
