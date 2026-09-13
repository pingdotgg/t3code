import {
  DEFAULT_API_BASE_URL,
  normalizeApiBaseUrl,
} from "@distilled.cloud/fly-io";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import { getEnv, getEnvRedacted, retryOnce } from "../Auth/Env.ts";
import { AlchemyProfile } from "../Auth/Profile.ts";
import * as Clank from "../Util/Clank.ts";

export const FLY_AUTH_PROVIDER_NAME = "Fly";
export const FLY_API_TOKEN_ENV = "FLY_API_TOKEN";
export const FLY_API_HOSTNAME_ENV = "FLY_API_HOSTNAME";

const STORAGE_KEY = "fly-stored";

export type FlyAuthConfig = { method: "env" } | { method: "stored" };

export type FlyStoredCredentials = {
  type: "token";
  apiKey: string;
  apiBaseUrl?: string;
};

export type FlyResolvedCredentials = {
  type: "token";
  apiKey: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: FlyAuthConfig["method"]; details?: string };
};

const options: Array<{
  value: FlyAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variables",
    hint: `${FLY_API_TOKEN_ENV} + optional ${FLY_API_HOSTNAME_ENV}`,
  },
  {
    value: "stored",
    label: "API Token",
    hint: "enter interactively, stored in ~/.alchemy/credentials",
  },
];

const resolveApiBaseUrl = (explicit?: string) =>
  getEnv(FLY_API_HOSTNAME_ENV).pipe(
    Effect.map((fromEnv) => normalizeApiBaseUrl(explicit ?? fromEnv)),
  );

/**
 * Layer that registers the Fly {@link AuthProvider} into the
 * {@link AuthProviders} registry. Include this in the Fly `providers()`
 * layer so `alchemy login` can discover it.
 *
 * Auth is a Fly.io API token (`FLY_API_TOKEN`). There is no OAuth flow.
 * An optional `FLY_API_HOSTNAME` overrides the Machines API root
 * (default `https://api.machines.dev/v1`).
 */
export const FlyAuth = AuthProviderLayer<
  FlyAuthConfig,
  FlyResolvedCredentials
>()(
  FLY_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const profiles = yield* AlchemyProfile;
    const store = yield* CredentialsStore;

    const loginStored = Effect.fn(function* (profileName: string) {
      const apiKey = yield* Clank.password({
        message: "Fly.io API Token",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const envHostname = yield* getEnv(FLY_API_HOSTNAME_ENV);
      const hostnamePrompt = yield* Clank.text({
        message: "Fly API hostname (Enter for default)",
        placeholder: DEFAULT_API_BASE_URL,
        defaultValue: envHostname ?? DEFAULT_API_BASE_URL,
      }).pipe(retryOnce);
      const trimmed = (hostnamePrompt ?? "").trim();
      const apiBaseUrl =
        trimmed.length > 0 && trimmed !== DEFAULT_API_BASE_URL
          ? trimmed
          : undefined;

      yield* store.write<FlyStoredCredentials>(profileName, STORAGE_KEY, {
        type: "token",
        apiKey,
        apiBaseUrl,
      });
      yield* Clank.success("Fly: credentials saved.");
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "Fly authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("stored", () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
      Effect.gen(function* () {
        if (ctx.ci) {
          return { method: "env" as const };
        }
        return yield* configureInteractive(profileName);
      }).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "failed to configure credentials",
              cause: e,
            }),
        ),
      );

    const resolveCredentials = (
      profileName: string,
      config: FlyAuthConfig,
    ): Effect.Effect<FlyResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when(
          { method: "env" },
          Effect.fn(function* () {
            const apiKey = yield* getEnvRedacted(FLY_API_TOKEN_ENV);
            if (!apiKey) {
              return yield* new AuthError({
                message: `Fly env credentials not found. Set ${FLY_API_TOKEN_ENV}.`,
              });
            }
            const apiBaseUrl = yield* resolveApiBaseUrl();
            return {
              type: "token" as const,
              apiKey,
              apiBaseUrl,
              source: { type: "env" as const, details: FLY_API_TOKEN_ENV },
            };
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store.read<FlyStoredCredentials>(profileName, STORAGE_KEY).pipe(
            Effect.flatMap((creds) =>
              creds == null
                ? Effect.fail(
                    new AuthError({
                      message:
                        "Fly stored credentials not found. Run: alchemy login --configure",
                    }),
                  )
                : resolveApiBaseUrl(creds.apiBaseUrl).pipe(
                    Effect.map((apiBaseUrl) => ({
                      type: "token" as const,
                      apiKey: Redacted.make(creds.apiKey),
                      apiBaseUrl,
                      source: { type: "stored" as const },
                    })),
                  ),
            ),
          ),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: FlyAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, STORAGE_KEY)
            .pipe(
              Effect.andThen(Clank.success("Fly: stored credentials removed")),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: FlyAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () =>
            // If FLY_API_TOKEN isn't set, fall through to the interactive picker
            // so the user can switch to `stored` (or be told to set the env var)
            // instead of silently failing later in `read`. The new selection is
            // persisted to the profile so subsequent logins don't re-prompt.
            getEnvRedacted(FLY_API_TOKEN_ENV).pipe(
              Effect.flatMap((apiKey) =>
                apiKey
                  ? Effect.void
                  : Effect.gen(function* () {
                      const next = yield* configureInteractive(profileName);
                      const existing = yield* profiles.getProfile(profileName);
                      yield* profiles.setProfile(profileName, {
                        ...existing,
                        [FLY_AUTH_PROVIDER_NAME]: next,
                      });
                    }),
              ),
            ),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read<FlyStoredCredentials>(profileName, STORAGE_KEY)
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
                ),
              ),
          ),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError(
            (e) => new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const prettyPrint = (profileName: string, config: FlyAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Effect.all([
            Console.log(`  apiKey: ${displayRedacted(creds.apiKey, 6)}`),
            Console.log(`  apiBaseUrl: ${creds.apiBaseUrl}`),
            Console.log(`  source: ${sourceStr}`),
          ]);
        }),
      );

    return {
      configure: configureCredentials,
      logout,
      login,
      prettyPrint,
      read: resolveCredentials,
    };
  }),
);
