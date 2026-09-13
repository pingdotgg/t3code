import { DEFAULT_API_BASE_URL } from "@distilled.cloud/hetzner";
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

export const HETZNER_AUTH_PROVIDER_NAME = "Hetzner";
export const HCLOUD_TOKEN_ENV = "HCLOUD_TOKEN";
export const HCLOUD_ENDPOINT_ENV = "HCLOUD_ENDPOINT";

const STORAGE_KEY = "hetzner-stored";

export type HetznerAuthConfig = { method: "env" } | { method: "stored" };

export type HetznerStoredCredentials = {
  type: "token";
  token: string;
  apiBaseUrl?: string;
};

export type HetznerResolvedCredentials = {
  type: "token";
  token: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: HetznerAuthConfig["method"]; details?: string };
};

const options: Array<{
  value: HetznerAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variables",
    hint: `${HCLOUD_TOKEN_ENV} + optional ${HCLOUD_ENDPOINT_ENV}`,
  },
  {
    value: "stored",
    label: "API Token",
    hint: "enter interactively, stored in ~/.alchemy/credentials",
  },
];

const resolveApiBaseUrl = (explicit?: string) =>
  getEnv(HCLOUD_ENDPOINT_ENV).pipe(
    Effect.map((fromEnv) => explicit ?? fromEnv ?? DEFAULT_API_BASE_URL),
  );

/**
 * Layer that registers the Hetzner {@link AuthProvider} into the
 * {@link AuthProviders} registry. Include this in the Hetzner
 * `providers()` layer so `alchemy login` can discover it.
 *
 * Auth is a Hetzner Cloud API token (`HCLOUD_TOKEN`). The token is
 * issued per project in the Cloud Console — there is no account-wide
 * token. An optional `HCLOUD_ENDPOINT` overrides the API root
 * (default `https://api.hetzner.cloud/v1`).
 */
export const HetznerAuth = AuthProviderLayer<
  HetznerAuthConfig,
  HetznerResolvedCredentials
>()(
  HETZNER_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const profiles = yield* AlchemyProfile;
    const store = yield* CredentialsStore;

    const loginStored = Effect.fn(function* (profileName: string) {
      const token = yield* Clank.password({
        message: "Hetzner Cloud API Token",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const envEndpoint = yield* getEnv(HCLOUD_ENDPOINT_ENV);
      const endpointPrompt = yield* Clank.text({
        message: "Hetzner API endpoint (Enter for default)",
        placeholder: DEFAULT_API_BASE_URL,
        defaultValue: envEndpoint ?? DEFAULT_API_BASE_URL,
      }).pipe(retryOnce);
      const trimmed = (endpointPrompt ?? "").trim();
      const apiBaseUrl =
        trimmed.length > 0 && trimmed !== DEFAULT_API_BASE_URL
          ? trimmed
          : undefined;

      yield* store.write<HetznerStoredCredentials>(profileName, STORAGE_KEY, {
        type: "token",
        token,
        apiBaseUrl,
      });
      yield* Clank.success("Hetzner: credentials saved.");
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "Hetzner authentication method",
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
      config: HetznerAuthConfig,
    ): Effect.Effect<HetznerResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when(
          { method: "env" },
          Effect.fn(function* () {
            const token = yield* getEnvRedacted(HCLOUD_TOKEN_ENV);
            if (!token) {
              return yield* new AuthError({
                message: `Hetzner env credentials not found. Set ${HCLOUD_TOKEN_ENV}.`,
              });
            }
            const apiBaseUrl = yield* resolveApiBaseUrl();
            return {
              type: "token" as const,
              token,
              apiBaseUrl,
              source: { type: "env" as const, details: HCLOUD_TOKEN_ENV },
            };
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store.read<HetznerStoredCredentials>(profileName, STORAGE_KEY).pipe(
            Effect.flatMap((creds) =>
              creds == null
                ? Effect.fail(
                    new AuthError({
                      message:
                        "Hetzner stored credentials not found. Run: alchemy login --configure",
                    }),
                  )
                : resolveApiBaseUrl(creds.apiBaseUrl).pipe(
                    Effect.map((apiBaseUrl) => ({
                      type: "token" as const,
                      token: Redacted.make(creds.token),
                      apiBaseUrl,
                      source: { type: "stored" as const },
                    })),
                  ),
            ),
          ),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: HetznerAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, STORAGE_KEY)
            .pipe(
              Effect.andThen(
                Clank.success("Hetzner: stored credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: HetznerAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () =>
            // If HCLOUD_TOKEN isn't set, fall through to the interactive picker
            // so the user can switch to `stored` (or be told to set the env var)
            // instead of silently failing later in `read`. The new selection is
            // persisted to the profile so subsequent logins don't re-prompt.
            getEnvRedacted(HCLOUD_TOKEN_ENV).pipe(
              Effect.flatMap((token) =>
                token
                  ? Effect.void
                  : Effect.gen(function* () {
                      const next = yield* configureInteractive(profileName);
                      const existing = yield* profiles.getProfile(profileName);
                      yield* profiles.setProfile(profileName, {
                        ...existing,
                        [HETZNER_AUTH_PROVIDER_NAME]: next,
                      });
                    }),
              ),
            ),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read<HetznerStoredCredentials>(profileName, STORAGE_KEY)
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

    const prettyPrint = (profileName: string, config: HetznerAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Effect.all([
            Console.log(`  token: ${displayRedacted(creds.token, 6)}`),
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
