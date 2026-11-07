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
    readonly stateDir: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Each development T3 home (one per worktree) owns its renderer storage.
    const destinationPath = input.isDevelopment
      ? path.join(input.stateDir, "electron")
      : path.join(input.appDataDirectory, "t3code-v2");
    const [legacyName, previousName] = input.isDevelopment
      ? ["T3 Code (Dev)", "t3code-dev"]
      : ["T3 Code (Alpha)", "t3code"];
    const inspect = (resourcePath: string) =>
      fs
        .exists(resourcePath)
        .pipe(
          Effect.mapError((cause) =>
            DesktopUserDataInitializationError.fromFileSystem(cause, "inspect", resourcePath),
          ),
        );
    // Chromium databases require their own profile for each running version.
    if (input.platform !== "win32") return destinationPath;
    const destinationState = path.join(destinationPath, "Local State");
    if (yield* inspect(destinationState)) return destinationPath;
    const legacyState = path.join(input.appDataDirectory, legacyName, "Local State");
    const sourceState = (yield* inspect(legacyState))
      ? legacyState
      : path.join(input.appDataDirectory, previousName, "Local State");
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
