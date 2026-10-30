import * as HostProcess from "@t3tools/shared/HostProcess";
import { isWindowsDrivePath } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// WSL mounts Windows drives under a configurable automount root, so only wslpath knows where.
// Untraced: it runs for every chip path, and only drive paths under WSL do any work.
export const toWslDrivePath = Effect.fnUntraced(function* (requestedPath: string) {
  // spawn throws on a NUL byte instead of failing.
  if (!isWindowsDrivePath(requestedPath) || requestedPath.includes("\0")) return requestedPath;
  const env = yield* HostProcess.Environment;
  if (
    (yield* HostProcess.Platform) !== "linux" ||
    (env.WSL_DISTRO_NAME === undefined && env.WSL_INTEROP === undefined)
  ) {
    return requestedPath;
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner
    .string(
      ChildProcess.make("wslpath", ["-u", requestedPath], {
        env,
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.timeout("1 second"),
      Effect.orElseSucceed(() => ""),
    );
  const linuxPath = output.endsWith("\n") ? output.slice(0, -1) : output;
  return linuxPath.startsWith("/") ? linuxPath : requestedPath;
});
