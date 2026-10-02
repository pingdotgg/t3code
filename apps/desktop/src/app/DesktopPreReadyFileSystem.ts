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

/**
 * A synchronous FileSystem for startup work that runs before Electron's ready.
 * Electron emits ready as soon as startup yields to the event loop. Only the
 * operations userData resolution needs are implemented.
 *
 * @public Service construction is part of the canonical Effect module API.
 */
export const make = FileSystem.makeNoop({
  // Like Effect's exists: only a missing path is false, other access errors fail.
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
  writeFileString: (path, data, options) =>
    syncFs("writeFileString", path, () =>
      NodeFS.writeFileSync(path, data, { flag: options?.flag ?? "w" }),
    ),
});

export const layer = Layer.succeed(FileSystem.FileSystem, make);
