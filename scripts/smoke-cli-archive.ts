#!/usr/bin/env node
/**
 * Unpacks a CLI archive into a scratch directory and runs the executable the
 * way an installer would: no repo, no node_modules, no Node on PATH. Catches
 * the failures that only show inside the single-executable, such as an
 * external package reached through `import` or a native addon the hardened
 * runtime refuses to load.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

export class CliArchiveSmokeError extends Schema.TaggedError<CliArchiveSmokeError>()(
  "CliArchiveSmokeError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `CLI archive smoke test failed while ${this.step}: ${this.detail}`;
  }
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runExecutable = Effect.fn("runExecutable")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(executable, args, {
      cwd,
      // The service launcher context must not leak in from a developer shell.
      env: { PATH: process.env.PATH ?? "", HOME: cwd, USERPROFILE: cwd, TMPDIR: cwd, TEMP: cwd },
      extendEnv: false,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
});

const smokeCliArchive = Effect.fn("smokeCliArchive")(function* (input: {
  readonly archive: string;
  readonly expectVersion: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-smoke-" });

  const extract = yield* spawner
    .spawn(ChildProcess.make("tar", ["-xf", input.archive, "-C", scratch]))
    .pipe(Effect.flatMap((child) => child.exitCode));
  if (Number(extract) !== 0) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: `tar exited with ${String(extract)}`,
    });
  }
  const [root] = yield* fs.readDirectory(scratch);
  if (root === undefined) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: "the archive was empty",
    });
  }
  const contentDir = path.join(scratch, root);
  const executable = path.join(contentDir, platform === "win32" ? "t3.exe" : "t3");
  for (const required of [executable, path.join(contentDir, "client/index.html")]) {
    if (!(yield* fs.exists(required))) {
      return yield* new CliArchiveSmokeError({
        step: "checking the archive layout",
        detail: `missing ${path.relative(contentDir, required)}`,
      });
    }
  }

  const version = yield* runExecutable(executable, ["--version"], contentDir);
  if (version.exitCode !== 0 || !version.stdout.includes(input.expectVersion)) {
    return yield* new CliArchiveSmokeError({
      step: "running --version",
      detail: `exit ${String(version.exitCode)}\n${version.stdout}${version.stderr}`,
    });
  }

  // The preflight loads the persistence and terminal stacks, which is where
  // native addons (sqlite, node-pty, msgpackr-extract) actually get resolved.
  const preflight = yield* runExecutable(
    executable,
    [
      "__service-preflight",
      "--database-path",
      path.join(scratch, "state.sqlite"),
      "--launcher-protocol",
      "0",
    ],
    contentDir,
  );
  if (preflight.exitCode !== 0 || !preflight.stdout.includes('"version"')) {
    return yield* new CliArchiveSmokeError({
      step: "running the service preflight",
      detail: `exit ${String(preflight.exitCode)}\n${preflight.stdout}${preflight.stderr}`,
    });
  }
  yield* Effect.log(`[cli-smoke] ${root}: --version and preflight passed.`);
});

const command = Command.make(
  "smoke-cli-archive",
  {
    archive: Flag.string("archive"),
    expectVersion: Flag.string("expect-version"),
  },
  (input) => smokeCliArchive(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Extract a CLI archive and run its executable."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
