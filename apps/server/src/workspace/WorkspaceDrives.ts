// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { FilesystemBrowseEntry } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class DriveDiscoveryError extends Schema.TaggedError<DriveDiscoveryError>()("DriveDiscoveryError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

const VIRTUAL_LINUX_FILESYSTEMS = new Set([
  "autofs",
  "binfmt_misc",
  "bpf",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "efivarfs",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nsfs",
  "overlay",
  "proc",
  "pstore",
  "ramfs",
  "rpc_pipefs",
  "securityfs",
  "squashfs",
  "sysfs",
  "tmpfs",
  "tracefs",
]);

// Mountinfo escapes whitespace and backslashes as octal sequences. Read the
// process's mount table so custom mount paths and mount namespaces also work.
export function parseLinuxMountPaths(mountinfo: string): string[] {
  const paths = new Set<string>();
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    const mountPath = fields[4];
    const filesystem = fields[separator + 1];
    if (
      separator < 6 ||
      !mountPath?.startsWith("/") ||
      !filesystem ||
      VIRTUAL_LINUX_FILESYSTEMS.has(filesystem)
    )
      continue;
    paths.add(
      mountPath.replace(/\\([0-7]{3})/g, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      ),
    );
  }
  return [...paths];
}

const isAccessibleDirectory = Effect.fn("WorkspaceDrives.isAccessibleDirectory")(function* (
  fullPath: string,
) {
  return yield* Effect.tryPromise({
    try: () => NodeFSP.stat(fullPath),
    catch: (cause) => new DriveDiscoveryError({ path: fullPath, cause }),
  }).pipe(
    Effect.map((stat) => stat.isDirectory()),
    Effect.orElseSucceed(() => false),
    Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(false) }),
  );
});

export const list = Effect.fn("WorkspaceDrives.list")(function* () {
  const platform = yield* HostProcess.Platform;
  let candidates: FilesystemBrowseEntry[];
  if (platform === "win32") {
    candidates = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (letter) => ({
      name: `${letter}:`,
      fullPath: `${letter}:\\`,
    }));
  } else {
    let mountPaths: string[] = [];
    if (platform === "darwin") {
      const volumes = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir("/Volumes", { withFileTypes: true }),
        catch: (cause) => new DriveDiscoveryError({ path: "/Volumes", cause }),
      }).pipe(
        Effect.orElseSucceed(() => []),
        Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed([]) }),
      );
      mountPaths = volumes
        .filter((entry) => entry.isDirectory())
        .map((entry) => NodePath.posix.join("/Volumes", entry.name));
    } else if (platform === "linux") {
      const mountinfo = yield* Effect.tryPromise({
        try: () => NodeFSP.readFile("/proc/self/mountinfo", "utf8"),
        catch: (cause) => new DriveDiscoveryError({ path: "/proc/self/mountinfo", cause }),
      }).pipe(
        Effect.orElseSucceed(() => ""),
        Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed("") }),
      );
      mountPaths = parseLinuxMountPaths(mountinfo);
    }
    candidates = [
      { name: "Filesystem", fullPath: "/" },
      ...mountPaths
        .filter((fullPath) => fullPath !== "/")
        .map((fullPath) => ({
          name: NodePath.posix.basename(fullPath),
          fullPath,
        })),
    ];
  }

  const entries = yield* Effect.forEach(
    candidates,
    (entry) =>
      isAccessibleDirectory(entry.fullPath).pipe(
        Effect.map((accessible) => (accessible ? [entry] : [])),
      ),
    { concurrency: 26 },
  );
  return entries
    .flat()
    .toSorted((left, right) =>
      left.fullPath === "/"
        ? -1
        : right.fullPath === "/"
          ? 1
          : left.name.localeCompare(right.name) || left.fullPath.localeCompare(right.fullPath),
    );
});
