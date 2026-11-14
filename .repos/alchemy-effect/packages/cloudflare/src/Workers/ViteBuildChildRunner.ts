import * as NodeV8 from "node:v8";
import { PlatformServices, runMain } from "alchemy/Util/PlatformServices";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { viteBuildInProcess } from "./Sources/Vite.ts";
import type { ViteBuildChildConfig, ViteBuildChildResult } from "./ViteChild.shared.ts";

/**
 * Entry point of the one-shot Vite *build* child spawned by
 * `runViteBuildChild` (`ViteChild.ts`), with the project root as its
 * working directory. Running the build out of process is the isolation
 * boundary: vite resolves a relative root against live `process.cwd()`,
 * plugins read cwd freely, and the build's own spawns (via cross-spawn)
 * `process.chdir` the hosting process transiently — none of which is safe
 * inside the concurrent engine/test process.
 *
 * Protocol: V8-serialized {@link ViteBuildChildConfig} on stdin; the child
 * writes the V8-serialized {@link ViteBuildChildResult} to
 * `config.outputPath` and exits 0. Build logs stream over stdout/stderr;
 * a failed build exits non-zero with the error on stderr.
 */

const readConfig = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const chunks = yield* Stream.runCollect(stdio.stdin);
  return NodeV8.deserialize(Buffer.concat(chunks)) as ViteBuildChildConfig;
});

const program = Effect.gen(function* () {
  const config = yield* readConfig;
  const fs = yield* FileSystem.FileSystem;
  const { clientDirectory, foldkit, base, serverBundle, externalWorkspaces } =
    yield* viteBuildInProcess(config.rootDir, config.env, {
      main: config.main,
      framework: config.framework,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      viteEnvironments: config.viteEnvironments,
    });
  const [bundle, workspaces] = yield* Effect.all([serverBundle, externalWorkspaces]);
  const result: ViteBuildChildResult = {
    clientDirectory,
    foldkit,
    base,
    serverBundle: bundle,
    externalWorkspaces: Array.from(workspaces),
  };
  yield* fs.writeFile(config.outputPath, NodeV8.serialize(result));
});

// The parent streams this child's output and turns its exit code + stderr
// into the resource-scoped build error. Skip runMain's own `✖` report, but
// print the cause: vite only logs `✗ Build failed in …`, so this is the only
// place the actual error (a rolldown diagnostic, a plugin throwing during
// config resolution) reaches the parent.
runMain(
  program.pipe(
    Effect.tapCause((cause) => cause.pipe(Cause.pretty, Console.error)),
    Effect.provide(PlatformServices),
  ),
  { disableErrorReporting: true },
);
