import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  AuthError,
  getAuthProvider,
  presentEnvironment,
} from "./AuthProvider.ts";
import {
  ALCHEMY_PROFILE,
  DEFAULT_PROFILE_NAME,
  ProfileError,
  ProfileStore,
  SuppressMissingProviderConfig,
} from "./Profile.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";

/**
 * Resolve the selected Alchemy profile after the command's dotenv provider is
 * known. An omitted explicit override remains absent so it does not shadow
 * `ALCHEMY_PROFILE` from `.env` / `--env-file`.
 */
export const resolveProfileSelection = Effect.fn(function* (
  envFile: Option.Option<string>,
  override: string | undefined,
) {
  const base = yield* loadConfigProvider(envFile);
  const profiles = yield* ProfileStore;
  const selected = yield* profiles.current.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      withProfileOverride(base, override),
    ),
  );
  return {
    ...selected,
    source:
      override === undefined ? selected.source : ("command-line" as const),
  };
});

export const resolveProfileName = Effect.fn(function* (
  envFile: Option.Option<string>,
  override: string | undefined,
) {
  return (yield* resolveProfileSelection(envFile, override)).name;
});

/**
 * The shared preamble of every per-cloud `fromAuthProvider` /
 * `fromEnvironment` layer. Precedence: environment credentials (process
 * environment plus `.env` / `--env-file`) whenever the provider's declared
 * contract is fully present — CI or not, selected profile or not — then, in
 * CI, the provider's environment resolution alone (profiles do not exist
 * there), otherwise the selected profile.
 */
export const resolveProviderConfig = <
  C extends { method: string } = any,
  Credentials = any,
>(
  providerName: string,
) =>
  Effect.gen(function* () {
    const auth = yield* getAuthProvider<C, Credentials>(providerName);
    if (auth.readEnvironment !== undefined) {
      const used = yield* presentEnvironment(auth.environment);
      if (used !== undefined) {
        if (!(yield* SuppressMissingProviderConfig)) {
          yield* auth.logEnvironmentCredentials(used);
        }
        return {
          auth,
          profileName: undefined,
          config: undefined,
          resolve: auth.readEnvironment,
          source: "environment" as const,
        };
      }
    }
    const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false));
    if (ci) {
      if (auth.readEnvironment === undefined) {
        return yield* Effect.fail(
          new AuthError({
            message: `Auth provider '${providerName}' does not support environment credentials in CI.`,
          }),
        );
      }
      return {
        auth,
        profileName: undefined,
        config: undefined,
        resolve: auth.readEnvironment,
        source: "environment" as const,
      };
    }
    const profile = yield* ProfileStore;
    const selection = yield* profile.current;
    const profileName = selection.name;
    const config = yield* profile.loadProviderConfig(auth, profileName);
    return {
      auth,
      profileName,
      config,
      resolve: auth.read(profileName, config, (updated) =>
        profile.setProviderConfig(profileName, providerName, updated).pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: `${providerName}: could not persist refreshed credentials for profile '${profileName}'.`,
                cause,
              }),
          ),
        ),
      ),
      source: "profile" as const,
    };
  });

/** Let an explicit profile override configured selection without disturbing other keys. */
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
