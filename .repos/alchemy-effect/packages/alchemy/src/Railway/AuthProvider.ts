import * as railway from "@distilled.cloud/railway";
import { DEFAULT_API_BASE_URL } from "@distilled.cloud/railway";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Os from "node:os";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import { getEnv, getEnvRedacted, retryOnce } from "../Auth/Env.ts";
import { AlchemyProfile } from "../Auth/Profile.ts";
import * as Clank from "../Util/Clank.ts";
import {
  loginSessionUrl,
  pollLoginSessionToken,
  provideAnonymousRailway,
} from "./LoginSession.ts";

export const RAILWAY_AUTH_PROVIDER_NAME = "Railway";
export const RAILWAY_API_TOKEN_ENV = "RAILWAY_API_TOKEN";
export const RAILWAY_API_URL_ENV = "RAILWAY_API_URL";

const STORAGE_KEY = "railway-stored";
const OAUTH_STORAGE_KEY = "railway-oauth";

export type RailwayAuthConfig =
  | { method: "env" }
  | { method: "stored" }
  | { method: "oauth" };

export type RailwayStoredCredentials = {
  type: "token";
  token: string;
  apiBaseUrl?: string;
};

export type RailwayResolvedCredentials = {
  type: "token";
  token: Redacted.Redacted<string>;
  tokenKind: "account";
  apiBaseUrl: string;
  source: { type: RailwayAuthConfig["method"]; details?: string };
};

const options: Array<{
  value: RailwayAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "oauth",
    label: "OAuth (CLI login session)",
    hint: "recommended — open railway.com/cli-login, confirm the pairing code",
  },
  {
    value: "env",
    label: "Environment Variables",
    hint: `${RAILWAY_API_TOKEN_ENV} + optional ${RAILWAY_API_URL_ENV}`,
  },
  {
    value: "stored",
    label: "API Token",
    hint: "enter interactively, stored in ~/.alchemy/credentials",
  },
];

const normalizeApiBaseUrl = (explicit?: string) => {
  const trimmed = (explicit ?? "").trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : DEFAULT_API_BASE_URL;
};

const resolveApiBaseUrl = (explicit?: string) =>
  getEnv(RAILWAY_API_URL_ENV).pipe(
    Effect.map((fromEnv) => normalizeApiBaseUrl(explicit ?? fromEnv)),
  );

/**
 * Layer that registers the Railway {@link AuthProvider} into the
 * {@link AuthProviders} registry. Include this in the Railway `providers()`
 * layer so `alchemy login` can discover it.
 *
 * Supported methods:
 * - `env`: reads `RAILWAY_API_TOKEN` (account Bearer). Project tokens are
 *   not used — they cannot reach workspace-wide operations.
 * - `stored`: prompts for an API token and writes it to
 *   `~/.alchemy/credentials/<profile>/railway-stored.json`.
 * - `oauth`: CLI login session (`loginSessionCreate` → print pairing URL →
 *   poll `loginSessionVerify` / `loginSessionConsume` → store the token).
 *   Does not require a pre-existing token. An optional `RAILWAY_API_URL`
 *   overrides the backboard host (default `https://backboard.railway.com`).
 */
export const RailwayAuth = AuthProviderLayer<
  RailwayAuthConfig,
  RailwayResolvedCredentials
>()(
  RAILWAY_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const profiles = yield* AlchemyProfile;
    const store = yield* CredentialsStore;

    const loginStored = Effect.fn(function* (profileName: string) {
      const token = yield* Clank.password({
        message: "Railway API Token",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const envUrl = yield* getEnv(RAILWAY_API_URL_ENV);
      const urlPrompt = yield* Clank.text({
        message: "Railway API URL (Enter for default)",
        placeholder: DEFAULT_API_BASE_URL,
        defaultValue: envUrl ?? DEFAULT_API_BASE_URL,
      }).pipe(retryOnce);
      const trimmed = (urlPrompt ?? "").trim();
      const apiBaseUrl =
        trimmed.length > 0 && trimmed !== DEFAULT_API_BASE_URL
          ? trimmed
          : undefined;

      yield* store.write<RailwayStoredCredentials>(profileName, STORAGE_KEY, {
        type: "token",
        token,
        apiBaseUrl,
      });
      yield* Clank.success("Railway: credentials saved.");
      return { method: "stored" as const };
    });

    const loginOAuth = Effect.fn(function* (profileName: string) {
      const apiBaseUrl = yield* resolveApiBaseUrl();
      const hostname = yield* Effect.sync(() => {
        try {
          return Os.hostname();
        } catch {
          return "alchemy";
        }
      });

      const withAnonymous = <A, E>(
        effect: Effect.Effect<A, E, railway.RailwayOpContext>,
      ) => provideAnonymousRailway(effect, apiBaseUrl);

      const code = yield* withAnonymous(railway.loginSessionCreate({})).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "Railway login session create failed",
              cause: e,
            }),
        ),
      );

      const url = loginSessionUrl(code, { hostname });
      yield* Clank.info("Railway: opening browser for CLI login...");
      yield* Clank.info(url);
      yield* Clank.info(`Railway: pairing code is ${code}`);
      yield* Clank.openUrl(url).pipe(
        Effect.catch(() =>
          Clank.warn(
            "Railway: could not open browser automatically. Please open the URL above and enter the pairing code.",
          ),
        ),
      );
      yield* Clank.info("Railway: waiting for login (up to 5 minutes).");

      const cancel = withAnonymous(railway.loginSessionCancel({ code })).pipe(
        Effect.catch(() => Effect.void),
      );

      const token = yield* withAnonymous(pollLoginSessionToken(code)).pipe(
        Effect.onInterrupt(() => cancel),
        Effect.tapError(() => cancel),
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "Railway login session poll failed",
              cause: e,
            }),
        ),
      );

      if (token == null || token.length === 0) {
        yield* cancel;
        return yield* new AuthError({
          message: "Railway login session timed out after 5 minutes.",
        });
      }

      yield* store.write<RailwayStoredCredentials>(
        profileName,
        OAUTH_STORAGE_KEY,
        {
          type: "token",
          token,
          apiBaseUrl:
            apiBaseUrl === DEFAULT_API_BASE_URL ? undefined : apiBaseUrl,
        },
      );
      yield* Clank.success("Railway: OAuth credentials saved.");
      return { method: "oauth" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "Railway authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("stored", () => loginStored(profileName)),
            Match.when("oauth", () => loginOAuth(profileName)),
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
      config: RailwayAuthConfig,
    ): Effect.Effect<RailwayResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when(
          { method: "env" },
          Effect.fn(function* () {
            const token = yield* getEnvRedacted(RAILWAY_API_TOKEN_ENV);
            if (!token) {
              return yield* new AuthError({
                message: `Railway env credentials not found. Set ${RAILWAY_API_TOKEN_ENV}.`,
              });
            }
            const apiBaseUrl = yield* resolveApiBaseUrl();
            return {
              type: "token" as const,
              token,
              tokenKind: "account" as const,
              apiBaseUrl,
              source: {
                type: "env" as const,
                details: RAILWAY_API_TOKEN_ENV,
              },
            };
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store.read<RailwayStoredCredentials>(profileName, STORAGE_KEY).pipe(
            Effect.flatMap((creds) =>
              creds == null
                ? Effect.fail(
                    new AuthError({
                      message:
                        "Railway stored credentials not found. Run: alchemy login --configure",
                    }),
                  )
                : resolveApiBaseUrl(creds.apiBaseUrl).pipe(
                    Effect.map((apiBaseUrl) => ({
                      type: "token" as const,
                      token: Redacted.make(creds.token),
                      tokenKind: "account" as const,
                      apiBaseUrl,
                      source: { type: "stored" as const },
                    })),
                  ),
            ),
          ),
        ),
        Match.when({ method: "oauth" }, () =>
          store
            .read<RailwayStoredCredentials>(profileName, OAUTH_STORAGE_KEY)
            .pipe(
              Effect.flatMap((creds) =>
                creds == null
                  ? Effect.fail(
                      new AuthError({
                        message:
                          "Railway OAuth credentials not found. Run: alchemy login --configure",
                      }),
                    )
                  : resolveApiBaseUrl(creds.apiBaseUrl).pipe(
                      Effect.map((apiBaseUrl) => ({
                        type: "token" as const,
                        token: Redacted.make(creds.token),
                        tokenKind: "account" as const,
                        apiBaseUrl,
                        source: { type: "oauth" as const },
                      })),
                    ),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: RailwayAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, STORAGE_KEY)
            .pipe(
              Effect.andThen(
                Clank.success("Railway: stored credentials removed"),
              ),
            ),
        ),
        Match.when({ method: "oauth" }, () =>
          store
            .delete(profileName, OAUTH_STORAGE_KEY)
            .pipe(
              Effect.andThen(
                Clank.success("Railway: OAuth credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: RailwayAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () =>
            // If RAILWAY_API_TOKEN isn't set, fall through to the interactive
            // picker so the user can switch to `stored` (or be told to set
            // the env var) instead of silently failing later in `read`. The
            // new selection is persisted to the profile so subsequent logins
            // don't re-prompt.
            getEnvRedacted(RAILWAY_API_TOKEN_ENV).pipe(
              Effect.flatMap((token) =>
                token
                  ? Effect.void
                  : Effect.gen(function* () {
                      const next = yield* configureInteractive(profileName);
                      const existing = yield* profiles.getProfile(profileName);
                      yield* profiles.setProfile(profileName, {
                        ...existing,
                        [RAILWAY_AUTH_PROVIDER_NAME]: next,
                      });
                    }),
              ),
            ),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read<RailwayStoredCredentials>(profileName, STORAGE_KEY)
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
                ),
              ),
          ),
          Match.when({ method: "oauth" }, () =>
            store
              .read<RailwayStoredCredentials>(profileName, OAUTH_STORAGE_KEY)
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null
                    ? loginOAuth(profileName).pipe(Effect.asVoid)
                    : Effect.void,
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

    const prettyPrint = (profileName: string, config: RailwayAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Effect.all([
            Console.log(`  token: ${displayRedacted(creds.token, 6)}`),
            Console.log(`  tokenKind: ${creds.tokenKind}`),
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
