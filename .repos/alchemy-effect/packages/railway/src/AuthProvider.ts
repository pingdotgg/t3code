import * as Os from "node:os";
import { DEFAULT_API_BASE_URL, type GqlTransport } from "@distilled.cloud/railway";
import {
  AuthError,
  AuthProviderLayer,
  NeedsReauth,
  type ConfigureField,
  type ConfigureMethod,
  type ProviderDetails,
} from "alchemy/Auth/AuthProvider";
import { displayRedacted } from "alchemy/Auth/Credentials";
import {
  getEnv,
  getEnvRedacted,
  getEnvRedactedRequired,
  mapPromptCancellation,
} from "alchemy/Auth/Env";
import {
  storedSecret,
  storedValueText,
  validateFieldValues,
} from "alchemy/Auth/StoredAuthProvider";
import * as Interaction from "alchemy/Interaction";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  cancelLoginSession,
  createLoginSession,
  loginSessionUrl,
  pollLoginSessionToken,
  provideAnonymousRailway,
} from "./LoginSession.ts";

export const RAILWAY_AUTH_PROVIDER_NAME = "Railway";
export const RAILWAY_API_TOKEN_ENV = "RAILWAY_API_TOKEN";
export const RAILWAY_API_URL_ENV = "RAILWAY_API_URL";

/** Typed values stored in a Railway provider profile document. */
export const RailwayAuthConfigSchema = Schema.Union([
  Schema.Struct({ method: Schema.Literal("env") }),
  Schema.Struct({
    method: Schema.Literal("stored"),
    token: Schema.String,
    apiBaseUrl: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    method: Schema.Literal("oauth"),
    token: Schema.String,
    apiBaseUrl: Schema.optional(Schema.String),
  }),
]);
export type RailwayAuthConfig = typeof RailwayAuthConfigSchema.Type;

export type RailwayResolvedCredentials = {
  type: "token";
  token: Redacted.Redacted<string>;
  tokenKind: "account";
  apiBaseUrl: string;
  source: { type: RailwayAuthConfig["method"]; details?: string };
};

const options: Array<{ value: RailwayAuthConfig["method"]; label: string; description?: string }> =
  [
    {
      value: "oauth",
      label: "OAuth (CLI login session)",
      description: "recommended — open railway.com/cli-login, confirm the pairing code",
    },
    {
      value: "env",
      label: "Environment Variables",
      description: `${RAILWAY_API_TOKEN_ENV} + optional ${RAILWAY_API_URL_ENV}`,
    },
    {
      value: "stored",
      label: "API Token",
      description: "enter interactively and store inline in the provider file",
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
 * layer so the alchemy CLI can discover it.
 *
 * Supported methods:
 * - `env`: reads `RAILWAY_API_TOKEN` (account Bearer). Project tokens are
 *   not used — they cannot reach workspace-wide operations.
 * - `stored`: prompts for an API token and stores it in the provider file.
 * - `oauth`: CLI login session (`loginSessionCreate` → open the pairing URL →
 *   poll `loginSessionVerify` / `loginSessionConsume` → store the token).
 *   Does not require a pre-existing token. An optional `RAILWAY_API_URL`
 *   overrides the backboard host (default `https://backboard.railway.com`).
 */
export const RailwayAuth = AuthProviderLayer<RailwayAuthConfig, RailwayResolvedCredentials>()(
  RAILWAY_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const loginStored = Effect.fn(function* (_profileName: string) {
      const token = yield* Interaction.password({
        message: "Railway API Token",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(mapPromptCancellation);

      const envUrl = yield* getEnv(RAILWAY_API_URL_ENV);
      const urlPrompt = yield* Interaction.text({
        message: "Railway API URL (Enter for default)",
        placeholder: DEFAULT_API_BASE_URL,
        defaultValue: envUrl ?? DEFAULT_API_BASE_URL,
      }).pipe(mapPromptCancellation);
      const trimmed = (urlPrompt ?? "").trim();
      const apiBaseUrl =
        trimmed.length > 0 && trimmed !== DEFAULT_API_BASE_URL ? trimmed : undefined;

      yield* Interaction.success("Railway: credentials saved.");
      return { method: "stored" as const, token, apiBaseUrl };
    });

    const loginOAuth = Effect.fn(function* (_profileName: string) {
      const apiBaseUrl = yield* resolveApiBaseUrl();
      const hostname = yield* Effect.sync(() => {
        try {
          return Os.hostname();
        } catch {
          return "alchemy";
        }
      });

      const withAnonymous = <A, E>(effect: Effect.Effect<A, E, GqlTransport>) =>
        provideAnonymousRailway(effect, apiBaseUrl);

      const code = yield* withAnonymous(createLoginSession()).pipe(
        Effect.mapError((e) =>
          AuthError.make({ message: "Railway login session create failed", cause: e }),
        ),
      );

      const url = loginSessionUrl(code, { hostname });
      const cancel = withAnonymous(cancelLoginSession(code)).pipe(Effect.catch(() => Effect.void));

      const token = yield* Interaction.browserLogin({
        provider: "Railway",
        url,
        code,
        waitFor: withAnonymous(pollLoginSessionToken(code)),
      }).pipe(
        mapPromptCancellation,
        Effect.onInterrupt(() => cancel),
        Effect.tapError(() => cancel),
        Effect.mapError((e) =>
          Schema.is(AuthError)(e)
            ? e
            : AuthError.make({ message: "Railway login session poll failed", cause: e }),
        ),
      );

      if (token == null) {
        yield* cancel;
        return yield* AuthError.make({
          message: "Railway login session timed out after 5 minutes.",
        });
      }

      yield* Interaction.success("Railway: OAuth credentials saved.");
      return {
        method: "oauth" as const,
        token: Redacted.value(token),
        apiBaseUrl: apiBaseUrl === DEFAULT_API_BASE_URL ? undefined : apiBaseUrl,
      };
    });

    const configureInteractive = (profileName: string) =>
      Interaction.select({ message: "Railway authentication method", options }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () =>
              Effect.gen(function* () {
                const token = yield* getEnvRedacted(RAILWAY_API_TOKEN_ENV);
                if (!token) {
                  yield* Interaction.warning(
                    `Railway: ${RAILWAY_API_TOKEN_ENV} is not currently set — export it before deploying.`,
                  );
                }
                return { method: "env" as const };
              }),
            ),
            Match.when("stored", () => loginStored(profileName)),
            Match.when("oauth", () => loginOAuth(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const configureCredentials = (profileName: string) =>
      configureInteractive(profileName).pipe(
        Effect.mapError((e) =>
          AuthError.make({ message: "failed to configure credentials", cause: e }),
        ),
      );

    /**
     * Flag-driven (`--method stored --set ...` / `--method env`) fields,
     * mirroring the interactive prompts. OAuth requires a browser and stays
     * interactive-only, so it is deliberately absent.
     */
    const tokenFields: ReadonlyArray<ConfigureField> = [
      { name: "token", label: "Railway API Token", secret: true },
      {
        name: "apiBaseUrl",
        label: "Railway API URL",
        placeholder: DEFAULT_API_BASE_URL,
        optional: true,
      },
    ];

    const configureMethods: ReadonlyArray<ConfigureMethod> = [
      { method: "stored", fields: tokenFields },
      { method: "env", fields: [] },
    ];

    const configureWith = (
      _profileName: string,
      input: { readonly method: string; readonly values: Record<string, string> },
    ): Effect.Effect<RailwayAuthConfig, AuthError, Interaction.Interaction> =>
      input.method === "stored"
        ? validateFieldValues(RAILWAY_AUTH_PROVIDER_NAME, tokenFields, input.values).pipe(
            Effect.map((values) => ({
              method: "stored" as const,
              token: Redacted.value(storedSecret(values.token) ?? Redacted.make("")),
              apiBaseUrl: storedValueText(values.apiBaseUrl),
            })),
            Effect.tap(() => Interaction.success("Railway: credentials saved.")),
          )
        : input.method === "env"
          ? Effect.succeed({ method: "env" as const })
          : Effect.fail(
              AuthError.make({
                message: `Railway: unknown method '${input.method}'. Valid methods: stored, env. (OAuth is interactive-only.)`,
              }),
            );

    const readStoredToken = (
      config: Extract<RailwayAuthConfig, { method: "stored" | "oauth" }>,
    ): Effect.Effect<RailwayResolvedCredentials, AuthError> =>
      Effect.gen(function* () {
        const apiBaseUrl = yield* resolveApiBaseUrl(config.apiBaseUrl);
        return {
          type: "token" as const,
          token: Redacted.make(config.token),
          tokenKind: "account" as const,
          apiBaseUrl,
          source: { type: config.method },
        };
      });

    const resolveCredentials = (
      profileName: string,
      config: RailwayAuthConfig,
    ): Effect.Effect<RailwayResolvedCredentials, AuthError | NeedsReauth> =>
      Match.value(config).pipe(
        Match.when(
          { method: "env" },
          Effect.fn(function* () {
            const token = yield* getEnvRedacted(RAILWAY_API_TOKEN_ENV);
            if (!token) {
              return yield* AuthError.make({
                message: `Railway env credentials not found. Set ${RAILWAY_API_TOKEN_ENV}.`,
              });
            }
            const apiBaseUrl = yield* resolveApiBaseUrl();
            return {
              type: "token" as const,
              token,
              tokenKind: "account" as const,
              apiBaseUrl,
              source: { type: "env" as const, details: RAILWAY_API_TOKEN_ENV },
            } satisfies RailwayResolvedCredentials;
          }),
        ),
        Match.when({ method: "stored" }, readStoredToken),
        Match.when({ method: "oauth" }, readStoredToken),
        Match.exhaustive,
      );

    const logout = (_profileName: string, config: RailwayAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () => Effect.void),
        // Railway account tokens have no revocation endpoint for CLI-session
        // tokens, so logout just drops the locally stored token.
        Match.when({ method: "oauth" }, () => Effect.void),
        Match.exhaustive,
      );

    const login = (profileName: string, config: RailwayAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () =>
          getEnvRedacted(RAILWAY_API_TOKEN_ENV).pipe(
            Effect.flatMap((token) =>
              token
                ? Effect.void
                : Effect.fail(
                    AuthError.make({
                      message:
                        `Railway: ${RAILWAY_API_TOKEN_ENV} is not set. Export it, or run ` +
                        `\`alchemy profile edit --profile ${profileName} --reconfigure ${RAILWAY_AUTH_PROVIDER_NAME}\` to switch methods.`,
                    }),
                  ),
            ),
          ),
        ),
        // Railway account tokens neither expire nor refresh, so login only
        // (re-)prompts when no credential is stored yet.
        Match.when({ method: "stored" }, (config) => Effect.succeed(config)),
        Match.when({ method: "oauth" }, (config) => Effect.succeed(config)),
        Match.exhaustive,
        Effect.mapError((e) =>
          Schema.is(AuthError)(e) ? e : AuthError.make({ message: "login failed", cause: e }),
        ),
      );

    const details = (
      profileName: string,
      config: RailwayAuthConfig,
    ): Effect.Effect<ProviderDetails, AuthError | NeedsReauth> =>
      resolveCredentials(profileName, config).pipe(
        Effect.map((creds) => ({
          lines: [
            { key: "token", value: displayRedacted(creds.token, 6) },
            { key: "tokenKind", value: creds.tokenKind },
            { key: "apiBaseUrl", value: creds.apiBaseUrl },
            {
              key: "source",
              value: creds.source.details
                ? `${creds.source.type} - ${creds.source.details}`
                : creds.source.type,
            },
          ],
        })),
      );

    const readEnvironment = Effect.gen(function* () {
      const token = yield* getEnvRedactedRequired(RAILWAY_API_TOKEN_ENV);
      const apiBaseUrl = yield* resolveApiBaseUrl();
      return {
        type: "token" as const,
        token,
        tokenKind: "account" as const,
        apiBaseUrl,
        source: { type: "env" as const, details: RAILWAY_API_TOKEN_ENV },
      } satisfies RailwayResolvedCredentials;
    });

    return {
      configSchema: RailwayAuthConfigSchema,
      configure: configureCredentials,
      configureWith,
      configureMethods,
      logout,
      login,
      details,
      read: resolveCredentials,
      readEnvironment,
      environment: [
        {
          name: RAILWAY_API_TOKEN_ENV,
          required: true,
          secret: true,
          description: "Account API token (Bearer).",
        },
        {
          name: RAILWAY_API_URL_ENV,
          required: false,
          description: "Backboard API base URL override.",
        },
      ],
    };
  }),
);
