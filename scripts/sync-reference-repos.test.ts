import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { referenceRepos } from "./lib/reference-repos.ts";
import {
  planReferenceRepoSync,
  resolveReferenceRepoRef,
  syncReferenceRepos,
} from "./sync-reference-repos.ts";

const encoder = new TextEncoder();
const effectSmol = referenceRepos[0]!;

function mockHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode("done\n")),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(mockHandle());
    }),
  );
}

it.layer(NodeServices.layer)("sync-reference-repos", (it) => {
  it.effect("resolves the effect-smol tag from the root catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-version-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "package.json"),
        '{"workspaces":{"catalog":{"effect":"4.0.0-beta.73"}}}',
      );

      assert.equal(
        yield* resolveReferenceRepoRef(effectSmol, rootDir, false),
        "effect@4.0.0-beta.73",
      );
    }),
  );

  it.effect("uses the latest branch without reading package versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-latest-",
      });

      assert.equal(yield* resolveReferenceRepoRef(effectSmol, rootDir, true), "main");
    }),
  );

  it.effect("plans an add for a missing subtree and a pull for an existing subtree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-plan-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "package.json"),
        '{"workspaces":{"catalog":{"effect":"4.0.0-beta.73"}}}',
      );

      const addPlan = yield* planReferenceRepoSync(effectSmol, rootDir, false);
      assert.equal(addPlan.action, "add");
      assert.deepStrictEqual(addPlan.args, [
        "subtree",
        "add",
        "--prefix=.repos/effect-smol",
        "https://github.com/Effect-TS/effect-smol.git",
        "effect@4.0.0-beta.73",
        "--squash",
      ]);

      yield* fs.makeDirectory(path.join(rootDir, effectSmol.prefix), { recursive: true });
      assert.equal((yield* planReferenceRepoSync(effectSmol, rootDir, false)).action, "pull");
    }),
  );

  it.effect("runs the planned git subtree command through the process service", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-run-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "package.json"),
        '{"workspaces":{"catalog":{"effect":"4.0.0-beta.73"}}}',
      );

      yield* syncReferenceRepos({ rootDir }).pipe(Effect.provide(mockSpawnerLayer(commands)));

      assert.deepStrictEqual(commands, [
        {
          command: "git",
          args: [
            "subtree",
            "add",
            "--prefix=.repos/effect-smol",
            "https://github.com/Effect-TS/effect-smol.git",
            "effect@4.0.0-beta.73",
            "--squash",
          ],
        },
      ]);
    });
  });

  it.effect("rejects unknown repo selectors", () =>
    Effect.gen(function* () {
      const error = yield* syncReferenceRepos({
        repoId: "missing",
        dryRun: true,
      }).pipe(Effect.flip);

      assert.equal(
        error.message,
        "Unknown reference repo 'missing'. Expected one of: effect-smol.",
      );
    }),
  );
});
