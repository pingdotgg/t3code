import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { UserFacingError } from "../UserFacingError.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { AuthError, getAuthProvider, presentEnvironment } from "./AuthProvider.ts";
import { cacheUntilExpiry } from "./CredentialsCache.ts";
import { ProfileStore, reloadProviderConfig, SuppressMissingProviderConfig } from "./Profile.ts";

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
    Effect.provideService(ConfigProvider.ConfigProvider, withProfileOverride(base, override)),
  );
  return {
    ...selected,
    source: override === undefined ? selected.source : ("command-line" as const),
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
export const resolveProviderConfig = <C extends { method: string } = any, Credentials = any>(
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
        return yield* AuthError.make({
          message: `Auth provider '${providerName}' does not support environment credentials in CI.`,
        });
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
      // Reload under the credentials lock on every resolve: a refresh
      // rotates the stored token, so `config` goes stale after the first one.
      resolve: auth.read(profileName, reloadProviderConfig(profile, auth, profileName), (updated) =>
        profile.setProviderConfig(profileName, providerName, updated).pipe(
          Effect.mapError((cause) =>
            AuthError.make({
              message: `${providerName}: could not persist refreshed credentials for profile '${profileName}'.`,
              cause,
            }),
          ),
        ),
      ),
      source: "profile" as const,
    };
  });

/**
 * Defer an effect that a layer hands out as its service value. The effect
 * runs on first use, outside the layer build, so the services it needs are
 * captured now and provided to it. Building the layer then never runs the
 * effect, e.g. never requires a configured profile.
 *
 * The `ConfigProvider` is a reference, so it is not part of `R`; capture it
 * too. Otherwise the first use reads config through whatever provider is
 * ambient there — e.g. a Function's init, which binds every key it loads into
 * the Function's env and would ship the deployer's credentials (#1842).
 */
export const deferUntilFirstUse = <A, E, R>(resolve: Effect.Effect<A, E, R>) =>
  Effect.map(
    Effect.all([Effect.context<R>(), ConfigProvider.ConfigProvider]),
    ([context, configProvider]) =>
      resolve.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
        Effect.provideContext(context),
      ),
  );

/**
 * A provider's credentials could not be resolved when a cloud operation first
 * needed them: no profile, the provider is not configured in it, or the
 * stored credentials can no longer be read or refreshed.
 */
export class CredentialsUnavailable extends Schema.TaggedError<CredentialsUnavailable>()(
  "CredentialsUnavailable",
  {
    provider: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  readonly [UserFacingError] = true;
}

/**
 * Credential services are `Effect<Config>` with no error channel, so a
 * failed resolution can only leave them as a defect. Die with
 * {@link CredentialsUnavailable} so the engine can tell it apart from a
 * provider crash and fail the operation with `CredentialsRequired`.
 */
export const orDieCredentialsUnavailable =
  (provider: string) =>
  <A, E extends { readonly message: string }, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.mapError((cause) =>
        CredentialsUnavailable.make({
          provider,
          message: cause.message,
          cause,
        }),
      ),
      Effect.orDie,
    );

/**
 * The credential recipe behind every provider's `fromAuthProvider` layer:
 * {@link resolveProviderConfig}'s precedence, deferred until first use (so
 * building provider layers never needs a configured profile), cached until
 * shortly before the credentials expire (forever when `expiresAt` is omitted
 * or returns `undefined`; failures are never cached, so a later `alchemy
 * profile` login is picked up), and mapped onto the client's shape.
 *
 * A failed resolution fails with {@link CredentialsUnavailable}, which the
 * engine reports as `CredentialsRequired`. `E` types that failure into the
 * client SDK's own credentials channel (e.g. distilled's `ConfigError`), so
 * users never see a new error type.
 *
 * ```ts
 * export const fromAuthProvider = () =>
 *   Layer.effect(
 *     Credentials,
 *     lazyCredentials<StripeResolvedCredentials, ConfigError>()(
 *       STRIPE_AUTH_PROVIDER_NAME,
 *       (creds) => ({ apiKey: creds.apiKey, apiBaseUrl: creds.apiBaseUrl }),
 *     ),
 *   );
 * ```
 */
export const lazyCredentials = <Resolved, E = CredentialsUnavailable>() =>
  Effect.fn("lazyCredentials")(function* <A>(
    providerName: string,
    toClient: (resolved: Resolved) => A,
    options?: { readonly expiresAt?: (resolved: Resolved) => number | undefined },
  ) {
    const unavailable = (prefix: string) => (cause: { readonly message: string }) =>
      CredentialsUnavailable.make({
        provider: providerName,
        message: `${prefix}${cause.message}`,
        cause,
      });
    const resolve = yield* resolveProviderConfig<{ method: string }, Resolved>(providerName).pipe(
      Effect.mapError(unavailable("")),
      Effect.flatMap(({ profileName, resolve }) => {
        const from = profileName === undefined ? "the environment" : `profile '${profileName}'`;
        return Effect.logDebug(`${providerName}: credentials from ${from}`).pipe(
          Effect.annotateLogs({ provider: providerName }),
          Effect.andThen(resolve),
          Effect.mapError(
            unavailable(`Failed to resolve ${providerName} credentials from ${from}: `),
          ),
        );
      }),
      deferUntilFirstUse,
    );
    const cached = yield* cacheUntilExpiry(resolve, options?.expiresAt ?? (() => undefined));
    // SAFETY: E is only the SDK channel the CredentialsUnavailable fails
    // through; the engine matches its tag around every provider call.
    // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- see SAFETY above
    return cached.pipe(Effect.map(toClient)) as Effect.Effect<A, E>;
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
