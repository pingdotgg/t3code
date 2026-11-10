import { listOrganizations } from "@distilled.cloud/planetscale";
import * as PsCredentialsModule from "@distilled.cloud/planetscale/Credentials";
import {
  AuthError,
  AuthProviderLayer,
  refreshHint,
  type ConfigureField,
  type ConfigureMethod,
  NeedsReauth,
  type ProviderDetails,
} from "alchemy/Auth/AuthProvider";
import { browserOAuth } from "alchemy/Auth/BrowserOAuth";
import { displayRedacted } from "alchemy/Auth/Credentials";
import { getEnvRedactedRequired, getEnvRequired, mapPromptCancellation } from "alchemy/Auth/Env";
import { withProfileCredentialsLock } from "alchemy/Auth/Lock";
import {
  storedSecret,
  storedValueText,
  validateFieldValues,
} from "alchemy/Auth/StoredAuthProvider";
import * as Interaction from "alchemy/Interaction";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as OAuthClient from "./OAuthClient.ts";

/**
 * Canonical name registered in {@link AuthProviders}. Use this key to look
 * up the PlanetScale {@link AuthProvider} from inside provider Layers.
 */
export const PLANETSCALE_AUTH_PROVIDER_NAME = "Planetscale";

/**
 * Provide PlanetScale `Credentials` + `HttpClient` to an Effect using a
 * just-obtained OAuth access token. Used during configure to call
 * org-discovery endpoints before the user has chosen an org.
 *
 * `organization` is required by the credential type but isn't consulted by
 * `listOrganizations` (it's a user-scoped endpoint), so an empty string is
 * fine here.
 */
const withOAuthCredentials = <A, E, R>(
  accessToken: string,
  effect: Effect.Effect<A, E, R | PsCredentialsModule.Credentials | HttpClient.HttpClient>,
): Effect.Effect<A, E, R> =>
  Effect.provide(
    effect,
    Layer.mergeAll(
      PsCredentialsModule.fromOAuth({
        accessToken: Redacted.make(accessToken),
        organization: "",
      }),
      FetchHttpClient.layer,
    ),
  );

/**
 * List the organizations the OAuth user belongs to and either auto-pick
 * (one org) or prompt the user to choose. Returns the org's URL slug
 * (`name` field, used as `{organization}` in API paths).
 */
const selectOrganization = (accessToken: string) =>
  Effect.gen(function* () {
    const list = yield* listOrganizations;
    const response = yield* list({});
    const orgs = response.data;
    if (orgs.length === 0) {
      return yield* AuthError.make({
        message: "Planetscale: no organizations found for this credential.",
      });
    }
    if (orgs.length === 1) {
      const org = orgs[0];
      if (org === undefined) {
        return yield* AuthError.make({
          message: "Planetscale: organization response was unexpectedly empty.",
        });
      }
      yield* Interaction.info(`Planetscale: using organization: ${org.name} (${org.id})`);
      return org.name;
    }
    return yield* Interaction.select({
      message: "Select a Planetscale organization",
      options: orgs.map((o) => ({
        value: o.name,
        label: o.name,
        description: o.id,
      })),
    }).pipe(mapPromptCancellation);
  }).pipe((e) => withOAuthCredentials(accessToken, e));

const options: Array<{
  value: PlanetscaleAuthConfig["method"];
  label: string;
  description?: string;
}> = [
  {
    value: "oauth",
    label: "OAuth",
    description: "recommended — browser-based login with automatic token refresh",
  },
  {
    value: "stored",
    label: "Service Token",
    description: "enter a service token and store it inline in the provider file",
  },
];

/**
 * Typed values stored in a PlanetScale provider profile document. Both
 * service-token and OAuth values are inline. PlanetScale has no PKCE flow,
 * so the OAuth application's
 *   `client_secret` ships in the CLI — see {@link OAuthClient}.
 */
export const PlanetscaleAuthConfigSchema = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("stored"),
    tokenId: Schema.String,
    token: Schema.String,
    organization: Schema.String,
  }),
  Schema.Struct({
    method: Schema.Literal("oauth"),
    organization: Schema.String,
    clientId: Schema.optional(Schema.String),
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Number,
    scopes: Schema.String.pipe(Schema.Array, Schema.mutable),
  }),
]);
export type PlanetscaleAuthConfig = typeof PlanetscaleAuthConfigSchema.Type;

/**
 * Resolved in-memory PlanetScale credentials returned by
 * {@link AuthProviderImpl.read}. Either a service token (`tokenId`/`token`)
 * or an OAuth access token.
 */
export type PlanetscaleResolvedCredentials =
  | {
      type: "apiToken";
      tokenId: Redacted.Redacted<string>;
      token: Redacted.Redacted<string>;
      organization: string;
      source: {
        type: PlanetscaleAuthConfig["method"] | "env";
        details?: string;
      };
    }
  | {
      type: "oauth";
      accessToken: Redacted.Redacted<string>;
      expires: number;
      organization: string;
      source: {
        type: PlanetscaleAuthConfig["method"] | "env";
        details?: string;
      };
    };

/**
 * Layer that registers the PlanetScale {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the
 * PlanetScale `providers()` layer so the alchemy CLI can discover it.
 *
 * Supported methods:
 * - `stored`: prompts for a service token and stores it inline.
 * - `oauth`: browser-based login storing access/refresh values inline.
 */
export const PlanetscaleAuth = AuthProviderLayer<
  PlanetscaleAuthConfig,
  PlanetscaleResolvedCredentials
>()(
  PLANETSCALE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const oauthLogin = (_profileName: string) =>
      Effect.gen(function* () {
        const authorization = yield* OAuthClient.authorize();

        const credentials = yield* browserOAuth({
          provider: "Planetscale",
          url: authorization.url,
          callback: OAuthClient.callback(authorization),
          exchange: (input) => OAuthClient.exchangeCallbackInput(input, authorization),
        });
        yield* Interaction.success("Planetscale: OAuth credentials saved.");
        return credentials;
      });

    const configureOAuth = Effect.fn(function* (profileName: string) {
      const oauthCreds = yield* oauthLogin(profileName);

      // Use the just-issued access token to list the user's orgs and let
      // them pick (mirrors Cloudflare's selectAccount). Requires the
      // `user:read_organizations` scope. If the call fails for any
      // reason — missing scope, network, off-spec response — fall back
      // to a manual prompt so login still completes.
      const organization = yield* oauthCreds.access.pipe(
        Redacted.value,
        selectOrganization,
        Effect.catch((e) =>
          Effect.gen(function* () {
            yield* Interaction.warning(
              `Planetscale: could not auto-list organizations (${String(e)}). Falling back to manual entry.`,
            );
            return yield* Interaction.text({
              message: "Planetscale Organization (URL slug)",
              validate: (v) => (v.length === 0 ? "Required" : undefined),
            }).pipe(mapPromptCancellation);
          }),
        ),
      );

      return {
        method: "oauth" as const,
        organization,
        clientId: oauthCreds.clientId,
        access: Redacted.value(oauthCreds.access),
        refresh: Redacted.value(oauthCreds.refresh),
        expires: oauthCreds.expires,
        scopes: oauthCreds.scopes,
      };
    });

    const loginStored = Effect.fn(function* (_profileName: string) {
      const tokenId = yield* Interaction.text({
        message: "Planetscale Service Token ID",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(mapPromptCancellation);

      const token = yield* Interaction.password({
        message: "Planetscale Service Token",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(mapPromptCancellation);

      const organization = yield* Interaction.text({
        message: "Planetscale Organization (URL slug)",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(mapPromptCancellation);

      yield* Interaction.success("Planetscale: credentials saved.");
      return { method: "stored" as const, tokenId, token, organization };
    });

    const configureInteractive = (profileName: string) =>
      Interaction.select({
        message: "Planetscale authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("oauth", () => configureOAuth(profileName)),
            Match.when("stored", () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const configureCredentials = (profileName: string) =>
      configureInteractive(profileName).pipe(
        Effect.mapError((e) =>
          AuthError.make({
            message: "failed to configure credentials",
            cause: e,
          }),
        ),
      );

    /**
     * Flag-driven (`--method stored --set ...`) fields, mirroring the
     * interactive service-token prompts. OAuth requires a browser and stays
     * interactive-only, so it is deliberately absent from
     * {@link configureMethods}.
     */
    const serviceTokenFields: ReadonlyArray<ConfigureField> = [
      { name: "tokenId", label: "Planetscale Service Token ID" },
      { name: "token", label: "Planetscale Service Token", secret: true },
      { name: "organization", label: "Planetscale Organization (URL slug)" },
    ];

    const configureMethods: ReadonlyArray<ConfigureMethod> = [
      { method: "stored", fields: serviceTokenFields },
    ];

    const configureWith = (
      _profileName: string,
      input: {
        readonly method: string;
        readonly values: Record<string, string>;
      },
    ): Effect.Effect<PlanetscaleAuthConfig, AuthError, Interaction.Interaction> =>
      input.method === "stored"
        ? validateFieldValues(
            PLANETSCALE_AUTH_PROVIDER_NAME,
            serviceTokenFields,
            input.values,
          ).pipe(
            Effect.map((values) => ({
              method: "stored" as const,
              tokenId: Redacted.value(storedSecret(values.tokenId) ?? Redacted.make("")),
              token: Redacted.value(storedSecret(values.token) ?? Redacted.make("")),
              organization: storedValueText(values.organization) ?? "",
            })),
            Effect.tap(() => Interaction.success("Planetscale: credentials saved.")),
          )
        : Effect.fail(
            AuthError.make({
              message: `Planetscale: unknown method '${input.method}'. Valid methods: stored. (OAuth is interactive-only.)`,
            }),
          );

    const resolveCredentials = (
      profileName: string,
      config: PlanetscaleAuthConfig,
      updateConfig?: (config: PlanetscaleAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Effect.gen(function* () {
        const reauth = refreshHint(PLANETSCALE_AUTH_PROVIDER_NAME, profileName);
        return yield* Match.value(config).pipe(
          Match.when({ method: "stored" }, (stored) =>
            Effect.succeed({
              type: "apiToken" as const,
              tokenId: Redacted.make(stored.tokenId),
              token: Redacted.make(stored.token),
              organization: stored.organization,
              source: { type: "stored" as const, details: undefined },
            } satisfies PlanetscaleResolvedCredentials),
          ),
          Match.when({ method: "oauth" }, (cfg) =>
            Effect.gen(function* () {
              const creds: OAuthClient.OAuthCredentials = {
                type: "oauth",
                clientId: cfg.clientId,
                access: Redacted.make(cfg.access),
                refresh: Redacted.make(cfg.refresh),
                expires: cfg.expires,
                scopes: cfg.scopes,
              };
              if (!OAuthClient.usesCurrentClient(creds)) {
                return yield* NeedsReauth.make({
                  provider: PLANETSCALE_AUTH_PROVIDER_NAME,
                  profile: profileName,
                  message: `Planetscale OAuth credentials for profile '${profileName}' were issued to an incompatible OAuth client and have been removed. ${reauth}`,
                });
              }
              // Refresh proactively if the token has expired (or is within
              // 10s of expiring). Persist the refreshed creds so subsequent
              // resolves don't repeat the round-trip.
              const now = yield* Clock.currentTimeMillis;
              const fresh =
                creds.expires > now + 10_000
                  ? creds
                  : yield* OAuthClient.refresh(creds).pipe(
                      // Only the refresh round-trip maps to NeedsReauth — a
                      // failed persist afterwards is a local I/O AuthError and
                      // passes through untouched.
                      Effect.mapError((e) =>
                        NeedsReauth.make({
                          provider: PLANETSCALE_AUTH_PROVIDER_NAME,
                          profile: profileName,
                          message: `Planetscale OAuth refresh failed. ${reauth}`,
                          cause: e,
                        }),
                      ),
                    );
              if (fresh !== creds) {
                yield* (
                  updateConfig?.({
                    method: "oauth",
                    organization: cfg.organization,
                    clientId: fresh.clientId,
                    access: Redacted.value(fresh.access),
                    refresh: Redacted.value(fresh.refresh),
                    expires: fresh.expires,
                    scopes: fresh.scopes,
                  }) ?? Effect.void
                );
              }
              return {
                type: "oauth" as const,
                accessToken: fresh.access,
                expires: fresh.expires,
                organization: cfg.organization,
                source: { type: "oauth" as const },
              } satisfies PlanetscaleResolvedCredentials;
            }),
          ),
          Match.exhaustive,
        );
      });

    const logout = (_profileName: string, config: PlanetscaleAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "stored" }, () => Effect.void),
        Match.when({ method: "oauth" }, () => Effect.void),
        Match.exhaustive,
      );

    const login = (
      profileName: string,
      config: PlanetscaleAuthConfig,
      updateConfig?: (config: PlanetscaleAuthConfig) => Effect.Effect<void, AuthError>,
      reload?: Effect.Effect<PlanetscaleAuthConfig, AuthError>,
    ) =>
      Match.value(config).pipe(
        Match.when({ method: "stored" }, (stored) => Effect.succeed(stored)),
        Match.when({ method: "oauth" }, (oauth) =>
          Effect.gen(function* () {
            const credentials: OAuthClient.OAuthCredentials = {
              type: "oauth",
              clientId: oauth.clientId,
              access: Redacted.make(oauth.access),
              refresh: Redacted.make(oauth.refresh),
              expires: oauth.expires,
              scopes: oauth.scopes,
            };
            if (!OAuthClient.usesCurrentClient(credentials)) {
              return yield* configureOAuth(profileName);
            }
            // Refresh tokens are single-use: refresh with the token stored
            // now, read under the lock, not the one `config` was read with.
            const outcome = yield* withProfileCredentialsLock(
              profileName,
              Effect.gen(function* () {
                const current = yield* reload ?? Effect.succeed(oauth);
                if (current.method !== "oauth") return { type: "browser" as const };
                const currentCredentials: OAuthClient.OAuthCredentials = {
                  type: "oauth",
                  clientId: current.clientId,
                  access: Redacted.make(current.access),
                  refresh: Redacted.make(current.refresh),
                  expires: current.expires,
                  scopes: current.scopes,
                };
                if (!OAuthClient.usesCurrentClient(currentCredentials)) {
                  return { type: "browser" as const };
                }
                return yield* Interaction.info("Planetscale: refreshing OAuth credentials...").pipe(
                  Effect.andThen(OAuthClient.refresh(currentCredentials)),
                  Effect.flatMap((credentials) => {
                    const config = {
                      ...current,
                      clientId: credentials.clientId,
                      access: Redacted.value(credentials.access),
                      refresh: Redacted.value(credentials.refresh),
                      expires: credentials.expires,
                      scopes: credentials.scopes,
                    };
                    // Saved here, under the lock, when the caller can take it;
                    // otherwise handed back for the caller to save.
                    const unsaved: Effect.Effect<typeof config | undefined, AuthError> =
                      updateConfig === undefined
                        ? Effect.succeed(config)
                        : Effect.as(updateConfig(config), undefined);
                    return unsaved.pipe(
                      Effect.map((config) => ({ type: "refreshed" as const, config })),
                    );
                  }),
                  Effect.tap(() =>
                    Interaction.success("Planetscale: OAuth credentials refreshed."),
                  ),
                );
              }),
            ).pipe(
              Effect.catchTag(
                [
                  "OAuthError",
                  "OAuthNetworkError",
                  "OAuthServerUnavailable",
                  "OAuthInvalidResponse",
                ],
                () => Effect.succeed({ type: "browser" as const }),
              ),
            );
            if (outcome.type === "browser") {
              return yield* configureOAuth(profileName);
            }
            return outcome.config;
          }),
        ),
        Match.exhaustive,
        Effect.mapError((e) => AuthError.make({ message: "login failed", cause: e })),
      );

    const details = (
      profileName: string,
      config: PlanetscaleAuthConfig,
      updateConfig?: (config: PlanetscaleAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Effect.all([
        resolveCredentials(profileName, config, updateConfig),
        Clock.currentTimeMillis,
      ]).pipe(
        Effect.map(([creds, now]): ProviderDetails => {
          const source: PlanetscaleResolvedCredentials["source"] = creds.source;
          const sourceStr = source.details ? `${source.type} - ${source.details}` : source.type;
          return Match.value(creds).pipe(
            Match.when({ type: "apiToken" }, (c) => ({
              lines: [
                { key: "tokenId", value: displayRedacted(c.tokenId, 3) },
                { key: "token", value: displayRedacted(c.token, 6) },
                { key: "organization", value: c.organization },
                { key: "source", value: sourceStr },
              ],
            })),
            Match.when({ type: "oauth" }, (c) => {
              const remainingMs = c.expires - now;
              const expiresAt = new Date(c.expires).toISOString();
              const expiresStr =
                remainingMs <= 0
                  ? `expired (${expiresAt})`
                  : `in ${Duration.format(Duration.millis(remainingMs))} (${expiresAt})`;
              return {
                lines: [
                  { key: "accessToken", value: displayRedacted(c.accessToken) },
                  { key: "expires", value: expiresStr },
                  { key: "organization", value: c.organization },
                  { key: "source", value: sourceStr },
                ],
              };
            }),
            Match.exhaustive,
          );
        }),
      );

    const readEnvironment = Effect.gen(function* () {
      const tokenId = yield* getEnvRedactedRequired("PLANETSCALE_API_TOKEN_ID");
      const token = yield* getEnvRedactedRequired("PLANETSCALE_API_TOKEN");
      const organization = yield* getEnvRequired("PLANETSCALE_ORGANIZATION");
      return {
        type: "apiToken" as const,
        tokenId,
        token,
        organization,
        source: {
          type: "env" as const,
          details: "PLANETSCALE_API_TOKEN_ID/PLANETSCALE_API_TOKEN",
        },
      } satisfies PlanetscaleResolvedCredentials;
    });

    return {
      configSchema: PlanetscaleAuthConfigSchema,
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
          name: "PLANETSCALE_API_TOKEN_ID",
          required: true,
          description: "Service token id.",
        },
        {
          name: "PLANETSCALE_API_TOKEN",
          required: true,
          secret: true,
          description: "Service token secret.",
        },
        {
          name: "PLANETSCALE_ORGANIZATION",
          required: true,
          description: "Organization URL slug.",
        },
        {
          name: "PLANETSCALE_API_BASE_URL",
          required: false,
          description: "API base URL override.",
        },
      ],
    };
  }),
);
