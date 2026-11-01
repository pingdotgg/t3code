// @effect-diagnostics nodeBuiltinImport:off -- FileSystem has no statfs, and its stat follows symlinks.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const MAX_DIRECTORY_ENTRIES = 100_000;

// Electron's fs reports .asar archives as empty directories; original-fs sees the real files.
const NodeFSP = ((process.getBuiltinModule("original-fs") as typeof NodeFS | undefined) ?? NodeFS)
  .promises;

export class DesktopDiskSpaceError extends Schema.TaggedError<DesktopDiskSpaceError>()(
  "DesktopDiskSpaceError",
  {
    operation: Schema.Literals(["freeBytes", "directoryBytes"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not measure disk space (${this.operation}).`;
  }
}

export class DesktopDiskSpace extends Context.Service<
  DesktopDiskSpace,
  {
    /** The temp directory a spawned installer inherits. */
    readonly tempDirectory: string;
    /** Bytes the current user can still write on the volume holding `path`. */
    readonly freeBytes: (path: string) => Effect.Effect<number, DesktopDiskSpaceError>;
    /** Total size of the regular files below `path`, without following symlinks. */
    readonly directoryBytes: (path: string) => Effect.Effect<number, DesktopDiskSpaceError>;
  }
>()("@t3tools/desktop/updates/DesktopDiskSpace") {}

async function sumDirectoryBytes(root: string): Promise<number> {
  let total = 0;
  let entries = 0;
  const pending = [root];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    const children = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(
      (cause: unknown) => {
        if (directory === root) throw cause;
        return [];
      },
    );
    entries += children.length;
    if (entries > MAX_DIRECTORY_ENTRIES) {
      throw new Error(`More than ${MAX_DIRECTORY_ENTRIES} entries below the directory.`);
    }
    for (const child of children) {
      const childPath = NodePath.join(directory, child.name);
      if (child.isDirectory()) pending.push(childPath);
      else if (child.isFile()) {
        total += await NodeFSP.lstat(childPath).then(
          (stats) => stats.size,
          () => 0,
        );
      }
    }
  }
  return total;
}

export const layer = Layer.succeed(DesktopDiskSpace, {
  tempDirectory: NodeOS.tmpdir(),
  freeBytes: Effect.fn("DesktopDiskSpace.freeBytes")(function* (path: string) {
    const stats = yield* Effect.tryPromise({
      try: () => NodeFSP.statfs(path),
      catch: (cause) => new DesktopDiskSpaceError({ operation: "freeBytes", cause }),
    });
    return stats.bavail * stats.bsize;
  }),
  directoryBytes: Effect.fn("DesktopDiskSpace.directoryBytes")(function* (path: string) {
    return yield* Effect.tryPromise({
      try: () => sumDirectoryBytes(path),
      catch: (cause) => new DesktopDiskSpaceError({ operation: "directoryBytes", cause }),
    });
  }),
});
