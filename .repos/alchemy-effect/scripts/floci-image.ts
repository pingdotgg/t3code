/**
 * Point the floci-backed suites at a locally built emulator when one exists.
 *
 * `pnpm floci:build` tags the `submodules/floci` checkout as `floci:dev`;
 * that is how an emulator patch gets exercised before its release image is
 * published to GHCR. When no such image exists the env is left unset so the
 * floci package resolves the pinned release image — hard-defaulting to a
 * missing ref would fail every suite's `docker run` before a test can run.
 *
 * Must run before any child test process is spawned and before any in-process
 * `ensureFloci`: `ensureFloci` reads `ALCHEMY_FLOCI_IMAGE` from `process.env`
 * (here and in every child, which inherits it), and a container running a
 * different image than the resolved one is recreated.
 */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

export const preferLocalFlociImage = Effect.fn(function* (label: string) {
  const configured = yield* Config.String("ALCHEMY_FLOCI_IMAGE").pipe(Config.withDefault(""));
  if (configured !== "") return;
  const spawner = yield* ChildProcessSpawner;
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make("docker", ["image", "inspect", "floci:dev"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    )
    // No docker binary behaves like a missing image.
    .pipe(Effect.orElseSucceed(() => 1));
  if (exitCode === 0) {
    yield* Effect.sync(() => {
      process.env.ALCHEMY_FLOCI_IMAGE = "floci:dev";
    });
    yield* Console.log(`${label}: using locally built floci:dev image`);
  } else {
    yield* Console.log(
      `${label}: no local floci:dev image (pnpm floci:build) — using the pinned release image`,
    );
  }
});
