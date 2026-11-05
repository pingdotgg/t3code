import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as MacAppVolume from "./MacAppVolume.ts";

// No process has this id, so the helper starts as if the app had already quit.
const EXITED_PID = "2147483647";

const runSwap = Effect.fn("test.runSwap")(function* (options: {
  readonly stageNewApp: boolean;
  readonly pid?: string;
  readonly waits?: string;
  readonly xattr?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const bin = path.join(root, "bin");
  const drive = path.join(root, "ExternalDrive");
  const target = path.join(drive, "T3 Code.app");
  const stage = path.join(drive, ".T3 Code.update");
  const staged = path.join(stage, "extracted", "T3 Code.app");
  const opened = path.join(root, "opened");

  yield* fileSystem.makeDirectory(bin);
  yield* fileSystem.writeFileString(
    path.join(bin, "open"),
    `#!/bin/sh\necho "$*" >> "${opened}"\n`,
  );
  yield* fileSystem.writeFileString(path.join(bin, "xattr"), `#!/bin/sh\n${options.xattr ?? ""}`);
  yield* fileSystem.chmod(path.join(bin, "open"), 0o755);
  yield* fileSystem.chmod(path.join(bin, "xattr"), 0o755);
  yield* fileSystem.makeDirectory(target, { recursive: true });
  yield* fileSystem.writeFileString(path.join(target, "version"), "1.2.3");
  yield* fileSystem.makeDirectory(path.dirname(staged), { recursive: true });
  if (options.stageNewApp) {
    yield* fileSystem.makeDirectory(staged);
    yield* fileSystem.writeFileString(path.join(staged, "version"), "1.2.4");
  }

  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(
      "/bin/sh",
      [
        "-c",
        MacAppVolume.SWAP_SCRIPT,
        "t3code-update",
        options.pid ?? EXITED_PID,
        target,
        staged,
        stage,
        ...(options.waits === undefined ? [] : [options.waits]),
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        extendEnv: true,
        env: { PATH: `${bin}:/usr/bin:/bin` },
      },
    ),
  );
  return {
    exitCode,
    version: yield* fileSystem.readFileString(path.join(target, "version")),
    stageLeft: yield* fileSystem.exists(stage),
    opened: (yield* fileSystem.exists(opened)) ? yield* fileSystem.readFileString(opened) : "",
    target,
  };
});

describe("MacAppVolume.SWAP_SCRIPT", () => {
  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "swaps the staged app in, or puts the previous one back, then reopens it",
    () =>
      Effect.gen(function* () {
        const swapped = yield* runSwap({ stageNewApp: true });
        assert.equal(swapped.exitCode, 0);
        assert.equal(swapped.version, "1.2.4");
        assert.isFalse(swapped.stageLeft);
        assert.equal(swapped.opened, `-n ${swapped.target}\n`);

        const restored = yield* runSwap({ stageNewApp: false });
        assert.equal(restored.version, "1.2.3");
        assert.isFalse(restored.stageLeft);
        assert.equal(restored.opened, `-n ${restored.target}\n`);

        // The app's exit hangs up and terminates the helper between the swap and the reopen.
        const signalled = yield* runSwap({
          stageNewApp: true,
          xattr: 'kill -HUP "$PPID"\nkill -TERM "$PPID"\n',
        });
        assert.equal(signalled.exitCode, 0);
        assert.equal(signalled.version, "1.2.4");
        assert.isFalse(signalled.stageLeft);
        assert.equal(signalled.opened, `-n ${signalled.target}\n`);

        const stillRunning = yield* runSwap({
          stageNewApp: true,
          pid: String(process.pid),
          waits: "1",
        });
        assert.notEqual(stillRunning.exitCode, 0);
        assert.equal(stillRunning.version, "1.2.3");
        assert.isFalse(stillRunning.stageLeft);
        assert.equal(stillRunning.opened, "");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
