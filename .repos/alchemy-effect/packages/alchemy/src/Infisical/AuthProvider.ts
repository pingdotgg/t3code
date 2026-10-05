import {
  anonymous,
  DEFAULT_API_BASE_URL,
  loginWithOidcAuth,
  loginWithUniversalAuth,
} from "@distilled.cloud/infisical";
import * as Retry from "@distilled.cloud/infisical/Retry";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/http/HttpClient";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureField,
} from "../Auth/AuthProvider.ts";
import { displayRedacted } from "../Auth/Credentials.ts";
import { getEnv, getEnvRedacted, mapPromptCancellation } from "../Auth/Env.ts";
import {
  collectFieldValues,
  storedValueText,
  validateFieldValues,
  type StoredValues,
} from "../Auth/StoredAuthProvider.ts";
import * as Interaction from "../Interaction.ts";
import {
  detectOidcToken,
  SUPPORTED_OIDC_PLATFORMS,
} from "../Auth/OidcToken.ts";

export const INFISICAL_TOKEN_ENV = "INFISICAL_TOKEN";
/** The machine identity to log into with a platform OIDC token. */
export const INFISICAL_IDENTITY_ID_ENV = "INFISICAL_IDENTITY_ID";
/** Same name the Infisical CLI uses for self-hosted instances. */
export const INFISICAL_API_URL_ENV = "INFISICAL_API_URL";
/** Explicit OIDC token for platforms that are not auto-detected. */
export const INFISICAL_OIDC_TOKEN_ENV = "INFISICAL_OIDC_TOKEN";
/** Optional audience to request in the platform's OIDC token. */
export const INFISICAL_OIDC_AUDIENCE_ENV = "INFISICAL_OIDC_AUDIENCE";

const PROVIDER_NAME = "Infisical";
const API_TIMEOUT = Duration.seconds(30);

/**
 * A machine identity's client id + secret. The secret never expires unless
 * given a TTL in Infisical, and Alchemy exchanges it for a short-lived
 * access token on every read, so this is the method for local development.
 */
const UniversalAuthConfig = Schema.Struct({
  method: Schema.Literal("universal-auth"),
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.NonEmptyString,
  apiBaseUrl: Schema.optional(Schema.String),
});

/** A user token from the dashboard's "Copy Token" menu item. Valid for 10 days. */
const AccessTokenConfig = Schema.Struct({
  method: Schema.Literal("access-token"),
  token: Schema.NonEmptyString,
  apiBaseUrl: Schema.optional(Schema.String),
});

export const InfisicalAuthConfigSchema = Schema.Union([
  UniversalAuthConfig,
  AccessTokenConfig,
]);
export type InfisicalAuthConfig = typeof InfisicalAuthConfigSchema.Type;

export interface InfisicalResolvedCredentials {
  readonly token: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

const apiBaseUrlField: ConfigureField = {
  name: "apiBaseUrl",
  label: "Infisical API URL",
  description:
    "For the EU cloud (https://eu.infisical.com) or a self-hosted instance.",
  placeholder: DEFAULT_API_BASE_URL,
  optional: true,
};

const universalAuthFields: ReadonlyArray<ConfigureField> = [
  {
    name: "clientId",
    label: "Machine identity client ID",
    description:
      "From the machine identity's Universal Auth settings in Infisical. See https://infisical.com/docs/documentation/platform/identities/universal-auth",
  },
  {
    name: "clientSecret",
    label: "Machine identity client secret",
    secret: true,
  },
  apiBaseUrlField,
];

const accessTokenFields: ReadonlyArray<ConfigureField> = [
  {
    name: "token",
    label: "Infisical user token",
    description:
      'From the account menu in the Infisical dashboard ("Copy Token"). Valid for 10 days.',
    secret: true,
  },
  apiBaseUrlField,
];

const toCredentials = (
  response: { readonly accessToken: string | Redacted.Redacted<string> },
  apiBaseUrl: string | undefined,
): InfisicalResolvedCredentials => ({
  token: Redacted.isRedacted(response.accessToken)
    ? response.accessToken
    : Redacted.make(response.accessToken),
  apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL,
});

/**
 * Exchange a machine identity's client credentials for an access token.
 * Infisical answers 401 when either half is wrong or the secret is spent.
 */
export const mintAccessToken = (config: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiBaseUrl?: string;
}) =>
  loginWithUniversalAuth({
    clientId: config.clientId,
    clientSecret: Redacted.make(config.clientSecret),
  }).pipe(
    Retry.none,
    Effect.provide(anonymous({ apiBaseUrl: config.apiBaseUrl })),
    Effect.timeout(API_TIMEOUT),
    Effect.map((response) => toCredentials(response, config.apiBaseUrl)),
    Effect.mapError(
      (cause) =>
        new AuthError({
          message:
            "Infisical rejected the machine identity credentials. Check the client ID and secret, and that the secret has not expired or hit its use limit.",
          cause,
        }),
    ),
  );

/**
 * Exchange a platform-issued OIDC token for an access token of the machine
 * identity whose OIDC auth trusts that platform's issuer.
 */
export const mintAccessTokenFromOidc = (config: {
  readonly identityId: string;
  readonly jwt: Redacted.Redacted<string>;
  readonly apiBaseUrl?: string;
}) =>
  loginWithOidcAuth({
    identityId: config.identityId,
    jwt: Redacted.value(config.jwt),
  }).pipe(
    Retry.none,
    Effect.provide(anonymous({ apiBaseUrl: config.apiBaseUrl })),
    Effect.timeout(API_TIMEOUT),
    Effect.map((response) => toCredentials(response, config.apiBaseUrl)),
    Effect.mapError(
      (cause) =>
        new AuthError({
          message: `Infisical rejected the OIDC login for identity '${config.identityId}': ${cause.message}. Check that the identity's OIDC auth trusts this platform's issuer, subject, and audience.`,
          cause,
        }),
    ),
  );

/**
 * Resolve the token a stored configuration grants. Annotated because the two
 * branches are differently shaped Effects and a union of Effects does not
 * flow through `flatMap`.
 */
const resolve = (
  config: InfisicalAuthConfig,
): Effect.Effect<
  InfisicalResolvedCredentials,
  AuthError,
  HttpClient.HttpClient
> =>
  config.method === "universal-auth"
    ? mintAccessToken(config)
    : Effect.succeed({
        token: Redacted.make(config.token),
        apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      });

/** Turn collected field values into a stored configuration. */
const toConfig = (
  method: InfisicalAuthConfig["method"],
  values: StoredValues,
): InfisicalAuthConfig => {
  const apiBaseUrl = storedValueText(values.apiBaseUrl);
  return method === "access-token"
    ? { method, token: storedValueText(values.token)!, apiBaseUrl }
    : {
        method,
        clientId: storedValueText(values.clientId)!,
        clientSecret: storedValueText(values.clientSecret)!,
        apiBaseUrl,
      };
};

/**
 * Verify Universal Auth with a login before storing it. Pasted access
 * tokens are used as supplied and checked when secrets are requested.
 */
const verify = (config: InfisicalAuthConfig) =>
  resolve(config).pipe(Effect.as(config));

const fieldsFor = (method: InfisicalAuthConfig["method"]) =>
  method === "universal-auth" ? universalAuthFields : accessTokenFields;

const chooseMethod = Interaction.accessors.prompt
  .select({
    message: "Infisical authentication method",
    options: [
      {
        value: "universal-auth" as const,
        label: "Machine identity",
        description:
          "Client ID and secret; mints a fresh access token on each run",
      },
      {
        value: "access-token" as const,
        label: "User token",
        description: "Copied from the dashboard; valid for 10 days",
      },
    ],
  })
  .pipe(mapPromptCancellation);

/**
 * How CI authenticates, decided from the environment: a ready token, or a
 * machine identity to log into with the platform's OIDC token. Environment
 * credentials take precedence over stored profiles, including outside CI.
 */
const readEnvironment = Effect.gen(function* () {
  const apiBaseUrl = yield* getEnv(INFISICAL_API_URL_ENV);
  const token = yield* getEnvRedacted(INFISICAL_TOKEN_ENV);
  if (token !== undefined && Redacted.value(token).length > 0) {
    return { token, apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL };
  }
  const identityId = yield* getEnv(INFISICAL_IDENTITY_ID_ENV);
  if (!identityId) {
    return yield* new AuthError({
      message: `Infisical credentials are missing. In CI set ${INFISICAL_TOKEN_ENV}, or set ${INFISICAL_IDENTITY_ID_ENV} to log in with the platform's OIDC token; locally run \`alchemy profile edit --add Infisical\`.`,
    });
  }
  const oidc = yield* detectOidcToken({
    token: INFISICAL_OIDC_TOKEN_ENV,
    audience: INFISICAL_OIDC_AUDIENCE_ENV,
  });
  if (oidc === undefined) {
    return yield* new AuthError({
      message: `${INFISICAL_IDENTITY_ID_ENV} is set but no platform OIDC token was found. Supported: ${SUPPORTED_OIDC_PLATFORMS}; elsewhere pass the token in ${INFISICAL_OIDC_TOKEN_ENV}.`,
    });
  }
  return yield* mintAccessTokenFromOidc({
    identityId,
    jwt: oidc.token,
    apiBaseUrl,
  });
});

/**
 * Infisical profile authentication: a machine identity's universal-auth
 * credentials (recommended) or a pasted access token.
 */
export const InfisicalAuth = AuthProviderLayer<
  InfisicalAuthConfig,
  InfisicalResolvedCredentials
>()(PROVIDER_NAME, {
  configSchema: InfisicalAuthConfigSchema,
  configure: () =>
    chooseMethod.pipe(
      Effect.flatMap((method) =>
        collectFieldValues(fieldsFor(method)).pipe(
          Effect.map((values) => toConfig(method, values)),
        ),
      ),
      Effect.flatMap(verify),
    ),
  configureMethods: [
    { method: "universal-auth", fields: universalAuthFields },
    { method: "access-token", fields: accessTokenFields },
  ],
  configureWith: (_, input) => {
    if (input.method !== "universal-auth" && input.method !== "access-token") {
      return Effect.fail(
        new AuthError({
          message: `Infisical: unknown method '${input.method}'. Valid methods: universal-auth, access-token.`,
        }),
      );
    }
    const method = input.method;
    return validateFieldValues(
      PROVIDER_NAME,
      fieldsFor(method),
      input.values,
    ).pipe(
      Effect.map((values) => toConfig(method, values)),
      Effect.flatMap(verify),
    );
  },
  // Nothing to re-authenticate: stored credentials are long-lived (or, for
  // access tokens, replaced by reconfiguring). Verifying them is enough.
  login: (_, config) => verify(config),
  // Client secrets are revoked from the Infisical dashboard by an admin;
  // there is nothing session-like to tear down.
  logout: () => Effect.void,
  read: (_, config) => resolve(config),
  details: (_, config) =>
    Effect.succeed({
      lines: [
        { key: "method", value: config.method },
        config.method === "universal-auth"
          ? { key: "clientId", value: config.clientId }
          : {
              key: "token",
              value: displayRedacted(Redacted.make(config.token)),
            },
        { key: "apiBaseUrl", value: config.apiBaseUrl ?? DEFAULT_API_BASE_URL },
      ],
    }),
  readEnvironment,
  environment: [
    {
      name: INFISICAL_TOKEN_ENV,
      required: true,
      secret: true,
      alternatives: [INFISICAL_IDENTITY_ID_ENV],
      description:
        "A machine identity access token; or set INFISICAL_IDENTITY_ID instead to log in with the platform's OIDC token (Vercel, GitHub Actions, GitLab CI, GCP)",
    },
    {
      name: INFISICAL_OIDC_TOKEN_ENV,
      required: false,
      secret: true,
      description:
        "Explicit OIDC token for platforms that are not auto-detected",
    },
    {
      name: INFISICAL_OIDC_AUDIENCE_ENV,
      required: false,
      description: "Audience to request in the platform's OIDC token",
    },
    {
      name: INFISICAL_API_URL_ENV,
      required: false,
      description: "Base URL of a self-hosted Infisical instance",
    },
  ],
});
