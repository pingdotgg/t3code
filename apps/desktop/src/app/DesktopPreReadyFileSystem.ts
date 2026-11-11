// @effect-diagnostics nodeBuiltinImport:off -- Effect's Node FileSystem is async, and pre-ready startup must not yield before the Clerk bridge registers its privileged scheme.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

const systemErrorTag = (cause: unknown): PlatformError.SystemErrorTag => {
  switch ((cause as NodeJS.ErrnoException | undefined)?.code) {
    case "EEXIST":
      return "AlreadyExists";
    case "ENOENT":
      return "NotFound";
    case "EACCES":
    case "EPERM":
      return "PermissionDenied";
    default:
      return "Unknown";
  }
};

const syncFs = <A>(method: string, path: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      PlatformError.systemError({
        _tag: systemErrorTag(cause),
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
        cause,
      }),
  });

/** @public */
export const make = FileSystem.makeNoop({
  lstat: (path) =>
    syncFs("lstat", path, () => {
      const stats = NodeFS.lstatSync(path);
      const type = stats.isSymbolicLink()
        ? "SymbolicLink"
        : stats.isDirectory()
          ? "Directory"
          : stats.isFile()
            ? "File"
            : "Unknown";
      return { ...stats, type } as unknown as FileSystem.File.Info;
    }),
  exists: (path) =>
    syncFs("exists", path, () => {
      NodeFS.accessSync(path);
      return true;
    }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(false),
      ),
    ),
  readFileString: (path) => syncFs("readFileString", path, () => NodeFS.readFileSync(path, "utf8")),
  makeDirectory: (path, options) =>
    syncFs("makeDirectory", path, () => {
      NodeFS.mkdirSync(path, { recursive: options?.recursive ?? false });
    }),
  remove: (path, options) =>
    syncFs("remove", path, () =>
      NodeFS.rmSync(path, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      }),
    ),
  writeFileString: (path, data, options) =>
    syncFs("writeFileString", path, () =>
      NodeFS.writeFileSync(path, data, { flag: options?.flag ?? "w" }),
    ),
  readLink: (path) => syncFs("readLink", path, () => NodeFS.readlinkSync(path)),
  rename: (oldPath, newPath) =>
    syncFs("rename", oldPath, () => NodeFS.renameSync(oldPath, newPath)),
  symlink: (fromPath, toPath) =>
    syncFs("symlink", toPath, () => NodeFS.symlinkSync(fromPath, toPath)),
});

export const layer = Layer.succeed(FileSystem.FileSystem, make);
