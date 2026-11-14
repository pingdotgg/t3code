import * as HostProcess from "@t3tools/shared/HostProcess";
import { isWindowsDrivePath } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// WSL mounts Windows drives under a configurable automount root, so only wslpath knows where.
// No WSL env check: servers started by systemd lack WSL_DISTRO_NAME, and off WSL the spawn just fails.
// Untraced: it runs for every chip path, and only drive paths on Linux do any work.
export const toWslDrivePath = Effect.fnUntraced(function* (requestedPath: string) {
  // spawn throws on a NUL byte instead of failing.
  if (!isWindowsDrivePath(requestedPath) || requestedPath.includes("\0")) return requestedPath;
  if ((yield* HostProcess.Platform) !== "linux") return requestedPath;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner
    .string(
      ChildProcess.make("wslpath", ["-u", requestedPath], {
        env: yield* HostProcess.Environment,
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

const unescapeMountField = (field: string) =>
  field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

// WSL2 mounts Windows drives as 9p with aname=drvfs; WSL1 reports the drvfs type itself.
export function isPathOnDrvfsMount(mounts: string, path: string): boolean {
  let longest = -1;
  let onDrvfs = false;
  for (const line of mounts.split("\n")) {
    const [, rawDir, type, options = ""] = line.split(" ");
    if (rawDir === undefined || type === undefined) continue;
    const dir = unescapeMountField(rawDir);
    const contains = dir === "/" || path === dir || path.startsWith(`${dir}/`);
    // Later lines of the same length win: they are mounted over earlier ones.
    if (!contains || dir.length < longest) continue;
    longest = dir.length;
    onDrvfs = type === "drvfs" || options.includes("aname=drvfs");
  }
  return onDrvfs;
}

// Untraced: it runs on every local status refresh and only reads a small kernel file.
export const isOnWslDriveMount = Effect.fnUntraced(function* (path: string) {
  if ((yield* HostProcess.Platform) !== "linux") return false;
  const fileSystem = yield* FileSystem.FileSystem;
  const mounts = yield* fileSystem
    .readFileString("/proc/self/mounts")
    .pipe(Effect.orElseSucceed(() => ""));
  return isPathOnDrvfsMount(mounts, path);
});
