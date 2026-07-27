import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import os from "node:os";
import path from "pathe";
import { isNonInteractive } from "../Util/interactive.ts";
import { AuthError } from "./AuthProvider.ts";
import type { AuthProvider, ConfigureContext } from "./AuthProvider.ts";

export const rootDir = path.join(os.homedir(), ".alchemy");
export const configFilePath = path.join(rootDir, "profiles.json");

/**
 * Config key consulted by the various `fromAuthProvider` /
 * `fromEnvironment` layers to pick which named profile in
 * `~/.alchemy/profiles.json` to use. Defaults to `"default"`.
 */
export const ALCHEMY_PROFILE = Config.string("ALCHEMY_PROFILE").pipe(
  Config.withDefault("default"),
);

export const CONFIG_VERSION = 0;

export class AlchemyConfig extends Context.Service<
  AlchemyConfig,
  {
    version: typeof CONFIG_VERSION;
    profiles: {
      [profileName: string]: AlchemyProfileProviders;
    };
  }
>()("Alchemy::Profiles") {}

export interface AlchemyProfileProviders {
  [providerName: string]: {
    /**
     * The method used to login to the provider. Different providers may use different methods, but common ones are:
     * - oauth: OAuth authentication
     * - api-key: API key authentication
     * - username-password: Username and password authentication
     * - token: Token authentication
     * - certificate: Certificate authentication
     * - ssh: SSH authentication
     * - other: Other authentication methods
     */
    method: string;
  };
}

const emptyConfig = (): AlchemyConfig["Service"] => ({
  version: CONFIG_VERSION,
  profiles: {},
});

/**
 * Service exposing on-disk profile helpers. All methods have `R = never` —
 * the {@link FileSystem.FileSystem} requirement is captured by
 * {@link ProfileLive} when the layer is built, freeing call sites from
 * having to thread `FileSystem` through their own Effects.
 *
 * Use {@link AlchemyProfile} directly when you need profile helpers — yield it
 * from your `Effect.gen` and call its methods (each has `R = never`).
 */
export interface ProfileService {
  readonly readConfig: Effect.Effect<AlchemyConfig["Service"]>;
  readonly writeConfig: (
    config: AlchemyConfig["Service"],
  ) => Effect.Effect<void, PlatformError>;
  readonly getProfile: (
    name: string,
  ) => Effect.Effect<AlchemyProfileProviders | undefined>;
  readonly setProfile: (
    name: string,
    profile: AlchemyProfileProviders,
  ) => Effect.Effect<void, PlatformError>;
  readonly deleteProfile: (
    name: string,
  ) => Effect.Effect<boolean, PlatformError>;
  readonly loadOrConfigure: <Config extends { method: string }>(
    auth: AuthProvider<Config>,
    profileName: string,
    ctx: ConfigureContext,
  ) => Effect.Effect<Config, AuthError | PlatformError>;
}

export class AlchemyProfile extends Context.Service<
  AlchemyProfile,
  ProfileService
>()("Alchemy::Profile") {}

/**
 * Layer that builds the {@link AlchemyProfile} service. Captures the
 * {@link FileSystem.FileSystem} dependency at layer-build time, so any
 * Effect that yields {@link AlchemyProfile} ends up with `R = Profile` (no
 * `FileSystem` leak). Provide this once at the top of your runtime
 * (alongside `PlatformServices` / `NodeContext`).
 */
export const ProfileLive = Layer.effect(
  AlchemyProfile,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const readConfig: Effect.Effect<AlchemyConfig["Service"]> = fs
      .readFileString(configFilePath)
      .pipe(
        Effect.flatMap((data) =>
          Effect.try({
            try: () => {
              const parsed = JSON.parse(data);
              if (parsed?.version !== CONFIG_VERSION) {
                // TODO(sam): this is destructive, should we maintain a chain of migrations from 0 to current?
                return emptyConfig();
              }
              return parsed as AlchemyConfig["Service"];
            },
            catch: emptyConfig,
          }),
        ),
        Effect.orElseSucceed(emptyConfig),
      );

    const writeConfig = (config: AlchemyConfig["Service"]) =>
      fs
        .makeDirectory(path.dirname(configFilePath), { recursive: true })
        .pipe(
          Effect.flatMap(() =>
            fs.writeFileString(configFilePath, JSON.stringify(config, null, 2)),
          ),
        );

    const getProfile = (name: string) =>
      readConfig.pipe(Effect.map((config) => config.profiles[name]));

    const setProfile = (name: string, profile: AlchemyProfileProviders) =>
      readConfig.pipe(
        Effect.tap((config) =>
          Effect.sync(() => (config.profiles[name] = profile)),
        ),
        Effect.flatMap(writeConfig),
      );

    const deleteProfile = (name: string) =>
      readConfig.pipe(
        Effect.flatMap((config) => {
          if (!(name in config.profiles)) {
            return Effect.succeed(false);
          }
          delete config.profiles[name];
          return writeConfig(config).pipe(Effect.as(true));
        }),
      );

    const loadOrConfigure = <Config extends { method: string }>(
      auth: AuthProvider<Config>,
      profileName: string,
      ctx: ConfigureContext,
    ) =>
      Effect.flatMap(getProfile(profileName), (existing) => {
        const stored = existing?.[auth.name];
        if (stored) {
          return Effect.succeed(stored as Config);
        }
        // No credentials are configured for this provider+profile. Driving
        // `auth.configure` requires an interactive terminal (clack prompts,
        // browser-based OAuth, ...). In a non-interactive, non-CI context
        // (e.g. a `vitest` run or piped stdout) there is no TTY to drive
        // those prompts, so bail *before* calling `auth.configure`.
        //
        // This matters beyond just avoiding a hang: `configure` is a locked
        // method, so entering it acquires a cross-process auth lockfile. We
        // must avoid creating that lock when we can't actually configure —
        // for OAuth providers a refresh token is typically single-use, so a
        // stray lock left by a doomed configure can wedge concurrent refreshes.
        if (!ctx.ci && isNonInteractive()) {
          return Effect.fail(
            new AuthError({
              message:
                `No credentials configured for '${auth.name}' in profile '${profileName}', ` +
                `and this process is non-interactive so it can't be configured interactively. ` +
                `Run \`alchemy login --profile ${profileName}\` to configure it, ` +
                `or set CI=1 to use environment-variable credentials.`,
            }),
          );
        }
        return Effect.tap(auth.configure(profileName, ctx), (config) =>
          setProfile(profileName, { ...existing, [auth.name]: config }),
        );
      });

    return {
      readConfig,
      writeConfig,
      getProfile,
      setProfile,
      deleteProfile,
      loadOrConfigure,
    } satisfies ProfileService;
  }),
);

/**
 * Returns a `ConfigProvider` that overrides `ALCHEMY_PROFILE` with the
 * given `profile` (when explicitly passed via the CLI `--profile` flag),
 * falling through to `base` for everything else.
 *
 * Use this to let the CLI's `--profile <name>` win over `$ALCHEMY_PROFILE`
 * without disturbing other config lookups.
 */
export const withProfileOverride = (
  base: ConfigProvider.ConfigProvider,
  profile: string | undefined,
): ConfigProvider.ConfigProvider => {
  if (profile === undefined) return base;
  const overrides: Record<string, string> = { ALCHEMY_PROFILE: profile };
  const overrideProvider = ConfigProvider.make((path) =>
    Effect.succeed(
      path.length === 1 && typeof path[0] === "string" && path[0] in overrides
        ? ConfigProvider.makeValue(overrides[path[0]]!)
        : undefined,
    ),
  );
  return ConfigProvider.orElse(base)(overrideProvider);
};
