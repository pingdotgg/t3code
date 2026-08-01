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
      // The CLI entrypoint renders this; a broken install must never exit
      // cleanly with no output.
      assert.include(error.diagnostic, "Failed to load node-pty for win32-x64.");
      assert.include(error.diagnostic, "native binding could not be loaded");
      assert.include(error.diagnostic, "reinstall t3");
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

it("resolves helper executability against the calling process, not any exec bit", () => {
  const owned = { ownerUid: 501, ownerGid: 20 };

  // Owner-only binary: executable for its owner, not for anyone else.
  assert.isTrue(
    NodePtyAdapter.modeIsExecutableFor({
      mode: 0o100,
      ...owned,
      processUid: 501,
      processGids: [20],
    }),
  );
  assert.isFalse(
    NodePtyAdapter.modeIsExecutableFor({
      mode: 0o100,
      ...owned,
      processUid: 502,
      processGids: [21],
    }),
  );

  // Group and other bits are honoured independently of the owner bit.
  assert.isTrue(
    NodePtyAdapter.modeIsExecutableFor({
      mode: 0o010,
      ...owned,
      processUid: 502,
      processGids: [20],
    }),
  );
  assert.isFalse(
    NodePtyAdapter.modeIsExecutableFor({
      mode: 0o600,
      ...owned,
      processUid: 501,
      processGids: [20],
    }),
  );
  assert.isTrue(
    NodePtyAdapter.modeIsExecutableFor({
      mode: 0o001,
      ...owned,
      processUid: 502,
      processGids: [21],
    }),
  );

  // Root and unknown identities fall back to "somebody can execute this".
  assert.isTrue(
    NodePtyAdapter.modeIsExecutableFor({ mode: 0o100, ...owned, processUid: 0, processGids: [0] }),
  );
  assert.isFalse(
    NodePtyAdapter.modeIsExecutableFor({ mode: 0o644, ...owned, processUid: 0, processGids: [0] }),
  );
  assert.isTrue(
    NodePtyAdapter.modeIsExecutableFor({
      mode: 0o100,
      ownerUid: null,
      ownerGid: null,
      processUid: null,
      processGids: [],
    }),
  );

  // The reported bug: a 0644 helper is never executable for anyone.
  assert.isFalse(
    NodePtyAdapter.modeIsExecutableFor({
      mode: 0o644,
      ...owned,
      processUid: 501,
      processGids: [20],
    }),
  );
});

it("leaves non-posix_spawnp failures untouched", () => {
  const cause = new Error("cwd does not exist");
  const described = NodePtyAdapter.describeSpawnFailure({
    cause,
    platform: "darwin",
    helperPath: "/pkg/node-pty/build/Release/spawn-helper",
    helperIsExecutable: false,
  });
  assert.equal(described, cause);
});

it("explains posix_spawnp failures caused by a non-executable spawn-helper", () => {
  const cause = new Error("posix_spawnp failed.");
  const described = NodePtyAdapter.describeSpawnFailure({
    cause,
    platform: "darwin",
    helperPath: "/pkg/node-pty/build/Release/spawn-helper",
    helperIsExecutable: false,
  });
  assert.instanceOf(described, PtyAdapter.SpawnHelperNotExecutableError);
  const error = described as PtyAdapter.SpawnHelperNotExecutableError;
  assert.equal(error.helperPath, "/pkg/node-pty/build/Release/spawn-helper");
  assert.include(error.message, 'chmod +x "/pkg/node-pty/build/Release/spawn-helper"');
  assert.equal(error.cause, cause);
  // The terminal manager keys its retry decision off the tag, not the wording.
  assert.isTrue(PtyAdapter.hasSpawnHelperNotExecutableCause(error));
  assert.isTrue(
    PtyAdapter.hasSpawnHelperNotExecutableCause(
      new PtyAdapter.PtySpawnError({ adapter: "node-pty", shell: "/bin/zsh", cause: error }),
    ),
  );
  assert.isFalse(PtyAdapter.hasSpawnHelperNotExecutableCause(cause));
});

it("keeps posix_spawnp failures as-is when the helper is executable or missing", () => {
  const cause = new Error("posix_spawnp failed.");
  assert.equal(
    NodePtyAdapter.describeSpawnFailure({
      cause,
      platform: "darwin",
      helperPath: "/pkg/node-pty/build/Release/spawn-helper",
      helperIsExecutable: true,
    }),
    cause,
  );
  assert.equal(
    NodePtyAdapter.describeSpawnFailure({
      cause,
      platform: "darwin",
      helperPath: null,
      helperIsExecutable: false,
    }),
    cause,
  );
  assert.equal(
    NodePtyAdapter.describeSpawnFailure({
      cause,
      platform: "win32",
      helperPath: "/pkg/node-pty/build/Release/spawn-helper",
      helperIsExecutable: false,
    }),
    cause,
  );
});

it("finds posix_spawnp mentions through nested error causes", () => {
  const nested = new Error("outer wrapper", {
    cause: new Error("posix_spawnp failed."),
  });
  const described = NodePtyAdapter.describeSpawnFailure({
    cause: nested,
    platform: "darwin",
    helperPath: "/pkg/spawn-helper",
    helperIsExecutable: false,
  });
  assert.instanceOf(described, Error);
  assert.include((described as Error).message, "chmod +x");
});
