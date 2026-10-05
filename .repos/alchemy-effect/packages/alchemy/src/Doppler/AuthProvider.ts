import { hostname } from "node:os";
import packageJson from "../../package.json" with { type: "json" };
import {
  authOidc,
  authorizeCliAuth,
  generateCliAuth,
  revokeCliAuth,
} from "@distilled.cloud/doppler";
import * as Retry from "@distilled.cloud/doppler/Retry";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureField,
} from "../Auth/AuthProvider.ts";
import { getEnv, getEnvRedacted, mapPromptCancellation } from "../Auth/Env.ts";
import {
  detectOidcToken,
  SUPPORTED_OIDC_PLATFORMS,
} from "../Auth/OidcToken.ts";
import {
  storedValueText,
  validateFieldValues,
} from "../Auth/StoredAuthProvider.ts";
import * as Interaction from "../Interaction.ts";

export const DopplerAuthConfigSchema = Schema.Struct({
  method: Schema.Literals(["login", "api-token"]),
  token: Schema.NonEmptyString,
});
export type DopplerAuthConfig = typeof DopplerAuthConfigSchema.Type;

export interface DopplerResolvedCredentials {
  readonly token: Redacted.Redacted<string>;
}

const PROVIDER_NAME = "Doppler";
export const DOPPLER_TOKEN_ENV = "DOPPLER_TOKEN";
/** A service account identity to log into with a platform OIDC token. */
export const DOPPLER_IDENTITY_ID_ENV = "DOPPLER_IDENTITY_ID";
/** Explicit OIDC token for platforms that are not auto-detected. */
export const DOPPLER_OIDC_TOKEN_ENV = "DOPPLER_OIDC_TOKEN";
/** Optional audience to request in the platform's OIDC token. */
export const DOPPLER_OIDC_AUDIENCE_ENV = "DOPPLER_OIDC_AUDIENCE";

/** How long the user has to approve the browser login. */
const LOGIN_TIMEOUT = Duration.minutes(5);
const APPROVAL_POLL_INTERVAL = Duration.seconds(2);
const API_TIMEOUT = Duration.seconds(30);

/**
 * Describe this machine the way Doppler's CLI auth endpoint expects it.
 * Doppler validates these fields, so the values mirror what its own CLI sends.
 */
const client = {
  // Doppler cuts the token name at the first ".", so drop any domain suffix
  // (e.g. "Yoru.local" -> "Yoru").
  hostname: `Alchemy (${hostname().split(".")[0]})`,
  // Doppler requires vMAJOR.MINOR.PATCH; prerelease suffixes are rejected.
  version: `v${packageJson.version.split("-")[0]}`,
  os: process.platform === "win32" ? "windows" : process.platform,
  // Doppler expects Go-style architecture names.
  arch:
    process.arch === "x64"
      ? "amd64"
      : process.arch === "ia32"
        ? "386"
        : process.arch,
};

/**
 * Poll Doppler until the user approves the login in their browser.
 * Doppler answers `409 Conflict` while approval is still pending; any other
 * failure (rejected, expired) ends the flow.
 */
const awaitApproval = (authorization: {
  polling_code: string | Redacted.Redacted<string>;
}) =>
  authorizeCliAuth({ code: authorization.polling_code }).pipe(
    Retry.none,
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      schedule: Schedule.spaced(APPROVAL_POLL_INTERVAL).pipe(
        Schedule.upTo({ duration: LOGIN_TIMEOUT }),
      ),
    }),
  );

/**
 * Explicit browser login. Only ever run from `alchemy profile edit` /
 * `profile refresh`; reading credentials or loading secrets never logs in.
 */
export const login = Effect.gen(function* () {
  const interaction = yield* Interaction.Interaction;

  const authorization = yield* generateCliAuth(client).pipe(
    Retry.none,
    Effect.timeout(API_TIMEOUT),
  );

  const openFailed = yield* Interaction.openUrl(authorization.auth_url).pipe(
    Effect.as(false),
    Effect.catch(() => Effect.succeed(true)),
  );

  // Show the "waiting" prompt for as long as polling takes; the prompt itself
  // never resolves, so the race is decided by approval (or the timeout).
  const waitingPrompt = interaction.prompt
    .awaitExternal({
      message: "Log in to Doppler",
      waitingLabel: "Waiting for Doppler authorization (up to 5 minutes)…",
      url: authorization.auth_url,
      code: authorization.code,
      openFailed,
      allowManualInput: false,
    })
    .pipe(mapPromptCancellation, Effect.andThen(Effect.never));

  const credentials = yield* Effect.raceFirst(
    awaitApproval(authorization),
    waitingPrompt,
  ).pipe(Effect.timeout(LOGIN_TIMEOUT));

  const config: DopplerAuthConfig = {
    method: "login",
    token: Redacted.isRedacted(credentials.token)
      ? Redacted.value(credentials.token)
      : credentials.token,
  };
  return config;
}).pipe(
  Effect.mapError(
    () =>
      new AuthError({
        message:
          "Doppler login did not complete. Run `alchemy profile edit --add Doppler` to try again, or configure an API token.",
      }),
  ),
);

const tokenFields: ReadonlyArray<ConfigureField> = [
  { name: "token", label: "Doppler API token", secret: true },
];

/** Interactive alternative to {@link login}: paste a service or personal token. */
const promptForToken = Interaction.accessors.prompt
  .password({
    message: "Doppler API token",
    description:
      "A service token or personal token. Stored in your Alchemy profile.",
    validate: (value) => (value.trim().length ? undefined : "Required"),
  })
  .pipe(
    mapPromptCancellation,
    Effect.map((token): DopplerAuthConfig => ({
      method: "api-token",
      token: token.trim(),
    })),
  );

const chooseMethod = Interaction.accessors.prompt
  .select({
    message: "Doppler authentication method",
    options: [
      {
        value: "login" as const,
        label: "Login",
        description: "Login using your browser",
      },
      {
        value: "api-token" as const,
        label: "API token",
        description: "Use a service token or personal token",
      },
    ],
  })
  .pipe(
    mapPromptCancellation,
    Effect.flatMap((method) => (method === "login" ? login : promptForToken)),
  );

/** Browser-login tokens are revocable; API tokens were minted elsewhere and are left alone. */
const revokeLoginToken = (config: DopplerAuthConfig) =>
  config.method === "login"
    ? revokeCliAuth({ token: Redacted.make(config.token) }).pipe(
        Retry.none,
        Effect.timeout(API_TIMEOUT),
        Effect.asVoid,
        Effect.mapError(
          () =>
            new AuthError({
              message:
                "Could not revoke the Doppler login token. Try logging out again.",
            }),
        ),
      )
    : Effect.void;

/**
 * Exchange a platform-issued OIDC token for a short-lived Doppler token via
 * the service account identity that trusts that platform's issuer.
 * Identities are a Team/Enterprise plan feature.
 */
export const mintTokenFromOidc = (config: {
  readonly identityId: string;
  readonly jwt: Redacted.Redacted<string>;
}) =>
  authOidc({
    identity: config.identityId,
    token: Redacted.value(config.jwt),
  }).pipe(
    Retry.none,
    Effect.timeout(API_TIMEOUT),
    Effect.map((response): DopplerResolvedCredentials => ({
      token: Redacted.isRedacted(response.token)
        ? response.token
        : Redacted.make(response.token),
    })),
    Effect.mapError(
      (cause) =>
        new AuthError({
          message: `Doppler rejected the OIDC login for identity '${config.identityId}': ${cause.message}. Check that the service account identity trusts this platform's issuer, subject, and audience, and that the workplace plan includes identities.`,
          cause,
        }),
    ),
  );

/**
 * How CI authenticates, decided from the environment: a ready token, or a
 * service account identity to log into with the platform's OIDC token.
 */
const readEnvironment = Effect.gen(function* () {
  const token = yield* getEnvRedacted(DOPPLER_TOKEN_ENV);
  if (token !== undefined && Redacted.value(token).length > 0) {
    return { token };
  }
  const identityId = yield* getEnv(DOPPLER_IDENTITY_ID_ENV);
  if (!identityId) {
    return yield* new AuthError({
      message: `Doppler credentials are missing. In CI set ${DOPPLER_TOKEN_ENV}, or set ${DOPPLER_IDENTITY_ID_ENV} to log in with the platform's OIDC token; locally run \`alchemy profile edit --add Doppler\` and choose Login.`,
    });
  }
  const oidc = yield* detectOidcToken({
    token: DOPPLER_OIDC_TOKEN_ENV,
    audience: DOPPLER_OIDC_AUDIENCE_ENV,
  });
  if (oidc === undefined) {
    return yield* new AuthError({
      message: `${DOPPLER_IDENTITY_ID_ENV} is set but no platform OIDC token was found. Supported: ${SUPPORTED_OIDC_PLATFORMS}; elsewhere pass the token in ${DOPPLER_OIDC_TOKEN_ENV}.`,
    });
  }
  return yield* mintTokenFromOidc({ identityId, jwt: oidc.token });
});

/** Doppler profile authentication: explicit browser Login or a stored API token. */
export const DopplerAuth = AuthProviderLayer<
  DopplerAuthConfig,
  DopplerResolvedCredentials
>()(PROVIDER_NAME, {
  configSchema: DopplerAuthConfigSchema,
  configure: () => chooseMethod,
  configureMethods: [{ method: "api-token", fields: tokenFields }],
  configureWith: (_, input) =>
    input.method === "api-token"
      ? validateFieldValues(PROVIDER_NAME, tokenFields, input.values).pipe(
          Effect.map((values): DopplerAuthConfig => ({
            method: "api-token",
            token: storedValueText(values.token)!,
          })),
        )
      : Effect.fail(
          new AuthError({
            message:
              "Doppler: use method 'api-token' for flag-driven configuration. Login requires interactive profile setup.",
          }),
        ),
  login: (_, config) => (config.method === "login" ? login : promptForToken),
  logout: (_, config) => revokeLoginToken(config),
  read: (_, config) => Effect.succeed({ token: Redacted.make(config.token) }),
  details: (_, config) =>
    Effect.succeed({ lines: [{ key: "method", value: config.method }] }),
  readEnvironment,
  environment: [
    {
      name: DOPPLER_TOKEN_ENV,
      required: true,
      secret: true,
      alternatives: [DOPPLER_IDENTITY_ID_ENV],
      description:
        "A service token or personal token; or set DOPPLER_IDENTITY_ID instead to log in with the platform's OIDC token (Vercel, GitHub Actions, GitLab CI, GCP)",
    },
    {
      name: DOPPLER_OIDC_TOKEN_ENV,
      required: false,
      secret: true,
      description:
        "Explicit OIDC token for platforms that are not auto-detected",
    },
    {
      name: DOPPLER_OIDC_AUDIENCE_ENV,
      required: false,
      description: "Audience to request in the platform's OIDC token",
    },
  ],
});
