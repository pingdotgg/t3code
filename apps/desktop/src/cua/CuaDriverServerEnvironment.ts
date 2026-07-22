import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const T3CODE_CUA_DRIVER_PATH_ENV = "T3CODE_CUA_DRIVER_PATH";
export const T3CODE_CUA_DRIVER_HOST_BUNDLE_ID_ENV = "T3CODE_CUA_DRIVER_HOST_BUNDLE_ID";
export const T3CODE_CUA_DRIVER_MODULE_URL_ENV = "T3CODE_CUA_DRIVER_MODULE_URL";

export class CuaDriverConfigurationError extends Schema.TaggedErrorClass<CuaDriverConfigurationError>()(
  "CuaDriverConfigurationError",
  {
    binaryPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not configure embedded cua-driver at '${this.binaryPath}'.`;
  }
}

export const resolveEmbeddedDriverPath = (
  environment: NodeJS.ProcessEnv = process.env,
  packagedDriverPath?: string,
): Option.Option<string> => {
  if (packagedDriverPath !== undefined) return Option.some(packagedDriverPath);
  return Option.fromNullishOr(environment[T3CODE_CUA_DRIVER_PATH_ENV]).pipe(
    Option.map((value) => value.trim()),
    Option.filter((value) => value.length > 0),
  );
};

const cuaEnvironmentNames = [
  T3CODE_CUA_DRIVER_PATH_ENV,
  T3CODE_CUA_DRIVER_HOST_BUNDLE_ID_ENV,
  T3CODE_CUA_DRIVER_MODULE_URL_ENV,
] as const;

const replaceCuaDriverServerEnvironment = Effect.fn("replaceCuaDriverServerEnvironment")(function* (
  updates: Readonly<Record<string, string>>,
) {
  const previous = Object.fromEntries(
    cuaEnvironmentNames.map((name) => [name, process.env[name]] as const),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }),
  );
  for (const name of cuaEnvironmentNames) delete process.env[name];
  Object.assign(process.env, updates);
});

/** Prevents inherited development variables from bypassing the desktop opt-in. */
export const disableCuaDriverServerEnvironment = Effect.fn("disableCuaDriverServerEnvironment")(
  function* () {
    yield* replaceCuaDriverServerEnvironment({});
  },
);

/**
 * Configures the local Node server to own cua-driver. The backend inherits
 * these values when Electron starts it; remote servers can set the same
 * variables in their own environment.
 */
export const configureCuaDriverServerEnvironment = Effect.fn("configureCuaDriverServerEnvironment")(
  function* (hostBundleId: string, resourcesPath?: string) {
    const path = yield* Path.Path;
    const driverPath = resolveEmbeddedDriverPath(
      process.env,
      resourcesPath === undefined ? undefined : path.join(resourcesPath, "cua-driver"),
    );
    if (Option.isNone(driverPath)) {
      return yield* new CuaDriverConfigurationError({ binaryPath: "<not configured>" });
    }

    const updates: Record<string, string> = {
      [T3CODE_CUA_DRIVER_PATH_ENV]: driverPath.value,
      [T3CODE_CUA_DRIVER_HOST_BUNDLE_ID_ENV]: hostBundleId,
    };
    if (resourcesPath !== undefined) {
      const moduleUrl = yield* path
        .toFileUrl(
          path.join(
            resourcesPath,
            "app.asar.unpacked/node_modules/@trycua/cua-driver/dist/embedded.js",
          ),
        )
        .pipe(
          Effect.map((url) => url.href),
          Effect.mapError(
            (cause) => new CuaDriverConfigurationError({ binaryPath: driverPath.value, cause }),
          ),
        );
      updates[T3CODE_CUA_DRIVER_MODULE_URL_ENV] = moduleUrl;
    }

    yield* replaceCuaDriverServerEnvironment(updates);
  },
);
