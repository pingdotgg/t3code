import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as NodeV8 from "node:v8";
import { PlatformServices, runMain } from "../../Util/PlatformServices.ts";
import { viteBuildInProcess } from "./Sources/Vite.ts";
import type {
  ViteBuildChildConfig,
  ViteBuildChildResult,
} from "./ViteChild.shared.ts";

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
  const { clientDirectory, base, serverBundle, externalWorkspaces } =
    yield* viteBuildInProcess(config.rootDir, config.env, {
      main: config.main,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      viteEnvironments: config.viteEnvironments,
    });
  const [bundle, workspaces] = yield* Effect.all([
    serverBundle,
    externalWorkspaces,
  ]);
  const result: ViteBuildChildResult = {
    clientDirectory,
    base,
    serverBundle: bundle,
    externalWorkspaces: Array.from(workspaces),
  };
  yield* fs.writeFile(config.outputPath, NodeV8.serialize(result));
});

runMain(program.pipe(Effect.provide(PlatformServices)));
