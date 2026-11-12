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

interface DriveOptions {
  readonly xattr?: string;
  /** Renames numbered first through last fail, as when the drive drops out mid-swap. */
  readonly failedMoves?: readonly [first: number, last: number];
  /** How many leading `open` calls fail. */
  readonly failedOpens?: number;
}

/** A drive holding the app, with each bundle present when given a version. */
const setUpDrive = Effect.fn("test.setUpDrive")(function* (
  options: DriveOptions & {
    readonly target?: string;
    readonly staged?: string;
    readonly previous?: string;
  },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const bin = path.join(root, "bin");
  const drive = path.join(root, "ExternalDrive");
  const target = path.join(drive, "T3 Code.app");
  const stage = path.join(drive, ".T3 Code.update");
  const staged = path.join(stage, "extracted", "T3 Code.app");
  const backup = path.join(stage, "previous.app");
  const opened = path.join(root, "opened");
  const moves = path.join(root, "moves");

  const tool = (name: string, body: string) =>
    fileSystem
      .writeFileString(path.join(bin, name), `#!/bin/sh\n${body}`)
      .pipe(Effect.andThen(fileSystem.chmod(path.join(bin, name), 0o755)));
  yield* fileSystem.makeDirectory(bin);
  yield* tool(
    "open",
    `echo "$*" >> "${opened}"\n[ "$(wc -l < "${opened}")" -gt ${options.failedOpens ?? 0} ]\n`,
  );
  yield* tool("xattr", options.xattr ?? "");
  if (options.failedMoves !== undefined) {
    const [first, last] = options.failedMoves;
    yield* tool(
      "mv",
      `n=$(($(cat "${moves}" 2>/dev/null || echo 0) + 1))\necho "$n" > "${moves}"\n[ "$n" -ge ${first} ] && [ "$n" -le ${last} ] && exit 1\nexec /bin/mv "$@"\n`,
    );
  }
  for (const [bundle, version] of [
    [target, options.target],
    [staged, options.staged],
    [backup, options.previous],
  ] as const) {
    yield* fileSystem.makeDirectory(path.dirname(bundle), { recursive: true });
    if (version === undefined) continue;
    yield* fileSystem.makeDirectory(bundle);
    yield* fileSystem.writeFileString(path.join(bundle, "version"), version);
  }

  const runHelper = (script: string, args: ReadonlyArray<string>) =>
    spawner.exitCode(
      ChildProcess.make("/bin/sh", ["-c", script, "t3code-update", ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        extendEnv: true,
        env: { PATH: `${bin}:/usr/bin:/bin` },
      }),
    );
  const read = (file: string) =>
    fileSystem
      .exists(file)
      .pipe(
        Effect.flatMap((exists) => (exists ? fileSystem.readFileString(file) : Effect.succeed(""))),
      );

  return {
    target,
    swap: (pid: string, budgets: ReadonlyArray<string>) =>
      runHelper(MacAppVolume.SWAP_SCRIPT, [pid, target, staged, stage, ...budgets]),
    putBack: runHelper(MacAppVolume.PUT_BACK_SCRIPT, [EXITED_PID, target, stage]),
    driveReturns: fileSystem.remove(path.join(bin, "mv"), { force: true }),
    state: Effect.all({
      version: read(path.join(target, "version")),
      stagedVersion: read(path.join(staged, "version")),
      backupVersion: read(path.join(backup, "version")),
      stageLeft: fileSystem.exists(stage),
      opened: read(opened),
    }),
  };
});

const runSwap = Effect.fn("test.runSwap")(function* ({
  stageNewApp,
  pid = EXITED_PID,
  budgets = [],
  ...options
}: DriveOptions & {
  readonly stageNewApp: boolean;
  readonly pid?: string;
  /** How many 0.2s waits the app gets to exit, then how many retries the swap gets. */
  readonly budgets?: ReadonlyArray<string>;
}) {
  const drive = yield* setUpDrive({
    ...options,
    target: "1.2.3",
    ...(stageNewApp ? { staged: "1.2.4" } : {}),
  });
  const exitCode = yield* drive.swap(pid, budgets);
  return { exitCode, target: drive.target, ...(yield* drive.state) };
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
        assert.notEqual(restored.exitCode, 0);
        assert.equal(restored.version, "1.2.3");
        assert.isTrue(restored.stageLeft);
        assert.equal(restored.opened, `-n ${restored.target}\n`);

        // A failed install move puts the previous app back, reopens it, and keeps the staged update.
        const rolledBack = yield* runSwap({ stageNewApp: true, failedMoves: [2, 2] });
        assert.notEqual(rolledBack.exitCode, 0);
        assert.equal(rolledBack.version, "1.2.3");
        assert.equal(rolledBack.stagedVersion, "1.2.4");
        assert.isTrue(rolledBack.stageLeft);
        assert.equal(rolledBack.opened, `-n ${rolledBack.target}\n`);

        // The app cannot be moved aside, so the helper reopens it and keeps the stage.
        const unmoved = yield* runSwap({ stageNewApp: true, failedMoves: [1, 1] });
        assert.notEqual(unmoved.exitCode, 0);
        assert.equal(unmoved.version, "1.2.3");
        assert.equal(unmoved.stagedVersion, "1.2.4");
        assert.isTrue(unmoved.stageLeft);
        assert.equal(unmoved.opened, `-n ${unmoved.target}\n`);

        const refused = yield* runSwap({ stageNewApp: true, failedOpens: 1 });
        assert.equal(refused.exitCode, 0);
        assert.equal(refused.version, "1.2.3");
        assert.isFalse(refused.stageLeft);
        assert.equal(refused.opened, `-n ${refused.target}\n-n ${refused.target}\n`);

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
          budgets: ["1"],
        });
        assert.notEqual(stillRunning.exitCode, 0);
        assert.equal(stillRunning.version, "1.2.3");
        assert.isFalse(stillRunning.stageLeft);
        assert.equal(stillRunning.opened, "");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "retries a swap the drive drops out of, and puts the app back once it quits from the stage",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const returned = yield* runSwap({
          stageNewApp: true,
          budgets: ["300", "3"],
          failedMoves: [2, 3],
        });
        assert.equal(returned.exitCode, 0);
        assert.equal(returned.version, "1.2.4");
        assert.isFalse(returned.stageLeft);
        assert.equal(returned.opened, `-n ${returned.target}\n`);

        const drive = yield* setUpDrive({ target: "1.2.3", staged: "1.2.4", failedMoves: [2, 99] });
        assert.notEqual(yield* drive.swap(EXITED_PID, ["300", "3"]), 0);
        const gone = yield* drive.state;
        assert.equal(gone.version, "");
        assert.equal(gone.backupVersion, "1.2.3");
        assert.equal(gone.opened, "");

        yield* drive.driveReturns;
        assert.equal(yield* drive.putBack, 0);
        const putBack = yield* drive.state;
        assert.equal(putBack.version, "1.2.3");
        assert.isFalse(putBack.stageLeft);
        assert.equal(putBack.opened, "");

        // A copy at the bundle path stays, and the one moved aside goes with the stage.
        const beside = yield* setUpDrive({ target: "1.2.4", previous: "1.2.3" });
        assert.equal(yield* beside.putBack, 0);
        const besideState = yield* beside.state;
        assert.equal(besideState.version, "1.2.4");
        assert.isFalse(besideState.stageLeft);
        assert.deepEqual(yield* fileSystem.readDirectory(beside.target), ["version"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
