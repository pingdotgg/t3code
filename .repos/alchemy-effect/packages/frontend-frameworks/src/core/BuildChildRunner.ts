/**
 * Shared child-process ENTRY for framework production builds.
 *
 * Executed only as a spawned process by `runBuildChild` (`BuildChild.ts`) —
 * never imported. `argv[2]` carries the JSON {@link BuildChildPayload}: the
 * framework source module to load (a file URL), the config for its exported
 * `buildInChild`, and the path to persist the resulting `BuildOutput` to.
 *
 * This is deliberately the ONLY module in the package with top-level
 * execution: every importable module (including the framework source
 * modules) stays pure — their `buildInChild` exports are plain functions
 * returning Effects, callable in-process by tests. Process concerns (argv
 * parsing, platform services, exit codes) live here, at the process
 * boundary where they belong.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import type { BuildChildModule, BuildChildPayload } from "./BuildChild.ts";
import { writeBuildOutput } from "./BuildOutput.ts";

const payload = JSON.parse(process.argv[2] ?? "{}") as BuildChildPayload;

const program = Effect.gen(function* () {
  const module = (yield* Effect.promise(
    () => import(payload.module),
  )) as Partial<BuildChildModule>;
  if (typeof module.buildInChild !== "function") {
    return yield* Effect.die(
      new Error(
        `Build child module ${payload.module} does not export a buildInChild function`,
      ),
    );
  }
  const output = yield* module.buildInChild(payload.config as never);
  yield* writeBuildOutput(payload.outputPath, output);
}).pipe(Effect.provide(NodeServices.layer));

void Effect.runPromise(program).then(
  // The macrotask hop lets buffered stdout/stderr drain before exiting.
  () => setTimeout(() => process.exit(0), 0),
  (error) => {
    console.error(error);
    setTimeout(() => process.exit(1), 0);
  },
);
