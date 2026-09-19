import { GitCommandError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

/** Forced copy-on-write: unsupported volumes must fail, never silently copy or hardlink. */
export const makeFileClone = Effect.fn("makeFileClone")(function* () {
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const supported = platform === "darwin";
  const clone = Effect.fn("FileClone.copy")(function* (
    sources: ReadonlyArray<string>,
    destination: string,
  ) {
    if (!supported) {
      return yield* new GitCommandError({
        operation: "FileClone.copy",
        command: "clone",
        cwd: destination,
        detail: "Filesystem cloning is unavailable on this platform",
      });
    }
    const code = yield* spawner
      .exitCode(
        ChildProcess.make("/bin/cp", ["-c", "-p", "-R", "-P", ...sources, destination], {
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.timeout(300_000));
    if (code !== 0) {
      return yield* new GitCommandError({
        operation: "FileClone.copy",
        command: "/bin/cp",
        cwd: destination,
        detail: "Filesystem clone unavailable",
        exitCode: code,
      });
    }
  });
  return { supported, clone };
});
