import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class DesktopUserDataInitializationError extends Schema.TaggedError<DesktopUserDataInitializationError>()(
  "DesktopUserDataInitializationError",
  {
    operation: Schema.Literals(["inspect", "read", "create-directory", "write"]),
    resourcePath: Schema.String,
    category: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not initialize Electron user data during ${this.operation} at ${this.resourcePath} (${this.category}).`;
  }

  static fromFileSystem(
    cause: PlatformError.PlatformError,
    operation: DesktopUserDataInitializationError["operation"],
    resourcePath: string,
  ) {
    return new DesktopUserDataInitializationError({
      operation,
      resourcePath,
      category: cause.reason._tag,
      cause,
    });
  }
}

export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = input.isDevelopment
      ? { current: "t3code-dev", legacy: "T3 Code (Dev)" }
      : { current: "t3code-v2", legacy: "T3 Code (Alpha)" };
    const destinationPath = path.join(input.appDataDirectory, names.current);
    const legacyPath = path.join(input.appDataDirectory, names.legacy);
    const inspect = (resourcePath: string) =>
      fs
        .exists(resourcePath)
        .pipe(
          Effect.mapError((cause) =>
            DesktopUserDataInitializationError.fromFileSystem(cause, "inspect", resourcePath),
          ),
        );
    if (input.isDevelopment) {
      return (yield* inspect(legacyPath)) ? legacyPath : destinationPath;
    }
    // Chromium databases require their own profile for each running version.
    if (input.platform !== "win32") return destinationPath;
    const destinationState = path.join(destinationPath, "Local State");
    if (yield* inspect(destinationState)) return destinationPath;
    const legacyState = path.join(legacyPath, "Local State");
    const sourceState = (yield* inspect(legacyState))
      ? legacyState
      : path.join(input.appDataDirectory, "t3code", "Local State");
    if (!(yield* inspect(sourceState))) return destinationPath;
    // Windows safeStorage keys live here. Copy only these preferences, never locked databases.
    const state = yield* fs
      .readFileString(sourceState)
      .pipe(
        Effect.mapError((cause) =>
          DesktopUserDataInitializationError.fromFileSystem(cause, "read", sourceState),
        ),
      );
    yield* fs
      .makeDirectory(destinationPath, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          DesktopUserDataInitializationError.fromFileSystem(
            cause,
            "create-directory",
            destinationPath,
          ),
        ),
      );
    yield* fs.writeFileString(destinationState, state, { flag: "wx" }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
      Effect.mapError((cause) =>
        DesktopUserDataInitializationError.fromFileSystem(cause, "write", destinationState),
      ),
    );
    return destinationPath;
  },
);

const GPU_CACHE_DIRECTORIES = [
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUPersistentCache",
];

// Keyed on Electron, not Chromium: Electron patches ship Chromium backports under the same Chrome version.
export const clearStaleGpuCaches = Effect.fn("desktop.userData.clearStaleGpuCaches")(
  function* (input: { readonly userDataPath: string; readonly electronVersion: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const markerPath = path.join(input.userDataPath, "gpu-cache-electron-version");
    const cachedVersion = yield* fs.readFileString(markerPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
    if (cachedVersion?.trim() === input.electronVersion) return;
    for (const name of GPU_CACHE_DIRECTORIES) {
      yield* fs.remove(path.join(input.userDataPath, name), { recursive: true, force: true });
    }
    yield* fs.writeFileString(markerPath, input.electronVersion);
  },
  (effect, input) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logWarning("could not clear stale GPU caches", {
          userDataPath: input.userDataPath,
          electronVersion: input.electronVersion,
          error: error.message,
        }),
      ),
    ),
);
