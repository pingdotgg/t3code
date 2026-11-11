import * as cfAccounts from "@distilled.cloud/cloudflare/accounts";
import * as CfCredentialsModule from "@distilled.cloud/cloudflare/Credentials";
import * as cfMemberships from "@distilled.cloud/cloudflare/memberships";
import {
  AuthError,
  AuthProviderLayer,
  NeedsReauth,
  reconfigureHint,
  refreshHint,
  type ConfigureField,
  type ConfigureMethod,
} from "alchemy/Auth/AuthProvider";
import { deviceOAuth } from "alchemy/Auth/BrowserOAuth";
import { CredentialsStore, displayRedacted } from "alchemy/Auth/Credentials";
import { getEnvRedacted, getEnvRequired, mapPromptCancellation } from "alchemy/Auth/Env";
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
import * as Stream from "effect/Stream";
import { clearStoreCredentials } from "../StateStore/CredentialsFile.ts";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  CloudflareAuthConfigSchema,
  validateAccountId,
  validateAccountIdField,
  type CloudflareAuthConfig,
  type CloudflareResolvedCredentials,
} from "./AuthConfig.ts";
import * as OAuthClient from "./OAuthClient.ts";
import {
  ALL_SCOPE_IDS,
  BASIC_SCOPES,
  customOAuthScopeDefaults,
  OAUTH_SCOPE_GROUPS,
  OAUTH_SCOPE_NAMES,
  OFFLINE_ACCESS_SCOPE,
  partitionOAuthScopes,
} from "./OAuthScopes.ts";

const options: Array<{
  value: CloudflareAuthConfig["method"];
  label: string;
  description?: string;
}> = [
  {
    value: "oauth",
    label: "OAuth",
    description: "recommended — browser device login with automatic token refresh",
  },
  {
    value: "stored",
    label: "API Token or API Key",
    description: "use an API token or global API key",
  },
];

const withOAuthCredentials = <A, E, R>(
  accessToken: string,
  effect: Effect.Effect<A, E, R | CfCredentialsModule.Credentials | HttpClient.HttpClient>,
): Effect.Effect<A, E, R> =>
  Effect.provide(
    effect,
    Layer.mergeAll(
      CfCredentialsModule.fromOAuth({
        load: Effect.succeed({ accessToken: Redacted.make(accessToken) }),
        refresh: () => Effect.die("refresh not expected during account selection"),
      }),
      FetchHttpClient.layer,
    ),
  );

/**
 * Accounts visible to a user-scoped OAuth token. `GET /accounts` returns an
 * EMPTY list for these tokens (it only lists accounts an account-scoped
 * credential can read), so memberships are the authoritative account list —
 * the same endpoint wrangler uses. `GET /accounts` remains as a fallback for
 * tokens authorized without `memberships.read` (custom scope selections).
 */
const listVisibleAccounts: Effect.Effect<
  ReadonlyArray<{ id: string; name: string }>,
  unknown,
  CfCredentialsModule.Credentials | HttpClient.HttpClient
> = Effect.gen(function* () {
  // Both endpoints page at 20 by default; walk every page so users with more
  // accounts than that can pick any of them.
  const membershipAccounts = yield* cfMemberships.listMemberships.items({ perPage: 50 }).pipe(
    Stream.runCollect,
    Effect.map((memberships) =>
      Array.from(memberships).flatMap((membership) =>
        membership.account != null &&
        (membership.status == null || membership.status === "accepted")
          ? [membership.account]
          : [],
      ),
    ),
    Effect.catch((error) =>
      Effect.logDebug("Cloudflare: listing memberships failed", error).pipe(
        Effect.as([] as Array<{ id: string; name: string }>),
      ),
    ),
  );
  if (membershipAccounts.length > 0) return membershipAccounts;
  const accounts = Array.from(
    yield* cfAccounts.listAccounts.items({ perPage: 50 }).pipe(Stream.runCollect),
  );
  yield* Effect.logDebug(
    `Cloudflare: memberships listed 0 accounts; /accounts listed ${accounts.length}`,
  );
  return accounts;
});

const selectAccount = (accessToken: string) =>
  Effect.gen(function* () {
    const accounts = yield* listVisibleAccounts;
    if (accounts.length === 0) {
      return yield* AuthError.make({
        message:
          "No Cloudflare accounts are visible to this credential. " +
          "Ensure the authorized OAuth scopes include 'memberships.read'.",
      });
    }
    const [account] = accounts;
    if (accounts.length === 1 && account !== undefined) {
      yield* Interaction.info(`Using Cloudflare account ${account.name}.`);
      return account.id;
    }
    return yield* Interaction.select({
      message: "Select a Cloudflare account",
      searchable: true,
      options: accounts.map((a) => ({ value: a.id, label: a.name, description: a.id })),
    }).pipe(mapPromptCancellation);
  }).pipe((e) => withOAuthCredentials(accessToken, e));

const promptAccountId = () =>
  Effect.gen(function* () {
    const interaction = yield* Interaction.Interaction;
    return yield* interaction.prompt
      .text({ message: "Cloudflare Account ID", validate: validateAccountIdField })
      .pipe(mapPromptCancellation);
  });

const accountIdField: ConfigureField = {
  name: "accountId",
  label: "Cloudflare Account ID",
  validate: validateAccountIdField,
};

/**
 * `--set` fields for `--method stored`. The persisted `credentialType` is
 * inferred from which secret is supplied: `apiToken` alone, or `apiKey`
 * together with `email`.
 */
const storedFields: ReadonlyArray<ConfigureField> = [
  {
    name: "apiToken",
    label: "Cloudflare API Token",
    description: "Pass either apiToken, or apiKey together with email.",
    secret: true,
    optional: true,
  },
  { name: "apiKey", label: "Cloudflare API Key", secret: true, optional: true },
  { name: "email", label: "Cloudflare Email", optional: true },
  accountIdField,
];

/**
 * Flag-driven configuration methods. OAuth is deliberately absent — it is
 * interactive-only (browser grant).
 */
const configureMethods: ReadonlyArray<ConfigureMethod> = [
  { method: "stored", fields: storedFields },
];

const promptOAuthScopes = (currentConfig?: CloudflareAuthConfig) =>
  Effect.gen(function* () {
    const interaction = yield* Interaction.Interaction;
    const mode = yield* interaction.prompt
      .select({
        message: "Cloudflare OAuth scopes",
        initialValue: "all" as const,
        options: [
          {
            value: "all" as const,
            label: "All Scopes",
            description: "authorize every available Cloudflare permission",
          },
          {
            value: "basic" as const,
            label: "Basic Scopes",
            description: "covers typical Alchemy use cases",
          },
          {
            value: "custom" as const,
            label: "Custom Scopes",
            description: "choose individual permissions",
          },
        ],
      })
      .pipe(mapPromptCancellation);
    if (mode === "basic") return [...BASIC_SCOPES];
    if (mode === "all") return [...ALL_SCOPE_IDS];
    return yield* interaction.prompt
      .multiSelect({
        message: "Select OAuth scopes",
        initialValues: customOAuthScopeDefaults(currentConfig),
        searchable: true,
        descriptionPlacement: "inline",
        options: OAUTH_SCOPE_GROUPS.flatMap((group) =>
          group.scopes.map((value) => ({
            value,
            label: OAUTH_SCOPE_NAMES[value],
            description: value,
            group: group.label,
          })),
        ),
        required: true,
      })
      .pipe(mapPromptCancellation);
  });

/**
 * Layer that registers the Cloudflare {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the Cloudflare
 * `providers()` layer so the alchemy CLI can discover it.
 */
export const CloudflareAuth = AuthProviderLayer<
  CloudflareAuthConfig,
  CloudflareResolvedCredentials
>()(
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;

    const oauthLogin = (_profileName: string, scopes: string[]) =>
      Effect.gen(function* () {
        const authorization = yield* OAuthClient.deviceAuthorize([...scopes, OFFLINE_ACCESS_SCOPE]);

        const credentials = yield* deviceOAuth({
          provider: "Cloudflare",
          authorization,
          token: OAuthClient.deviceToken(authorization),
        });
        yield* Interaction.success("Connected to Cloudflare with OAuth.");
        return credentials;
      });

    const loginStored = Effect.fn(function* () {
      const credentialType = yield* Interaction.select({
        message: "Cloudflare credential type",
        options: [
          { value: "apiToken" as const, label: "API Token", description: "recommended" },
          { value: "apiKey" as const, label: "API Key + Email" },
        ],
      }).pipe(mapPromptCancellation);

      return yield* Match.value(credentialType).pipe(
        Match.when("apiToken", () =>
          Effect.gen(function* () {
            const apiToken = yield* Interaction.password({
              message: "Cloudflare API Token",
              validate: (v) => (v.length === 0 ? "Required" : undefined),
            }).pipe(mapPromptCancellation, Effect.map(Redacted.make));
            const accountId = yield* promptAccountId();

            yield* Interaction.success("Cloudflare: credentials saved.");
            return {
              method: "stored" as const,
              credentialType: "apiToken" as const,
              apiToken: Redacted.value(apiToken),
              accountId,
            };
          }),
        ),
        Match.when("apiKey", () =>
          Effect.gen(function* () {
            const apiKey = yield* Interaction.password({
              message: "Cloudflare API Key",
              validate: (v) => (v.length === 0 ? "Required" : undefined),
            }).pipe(mapPromptCancellation, Effect.map(Redacted.make));

            const email = yield* Interaction.text({
              message: "Cloudflare Email",
              validate: (v) => (v.length === 0 ? "Required" : undefined),
            }).pipe(mapPromptCancellation, Effect.map(Redacted.make));
            const accountId = yield* promptAccountId();

            yield* Interaction.success("Cloudflare: credentials saved.");
            return {
              method: "stored" as const,
              credentialType: "apiKey" as const,
              apiKey: Redacted.value(apiKey),
              email: Redacted.value(email),
              accountId,
            };
          }),
        ),
        Match.exhaustive,
      );
    });

    const configureOAuth = Effect.fn(function* (
      profileName: string,
      currentConfig?: CloudflareAuthConfig,
    ) {
      const scopes = yield* promptOAuthScopes(currentConfig);

      const oauthCreds = yield* oauthLogin(profileName, [...scopes]);

      const accountId = yield* oauthCreds.access.pipe(
        Redacted.value,
        selectAccount,
        // Keep AuthError messages intact — they carry the actionable
        // diagnosis (e.g. "no accounts visible"); only wrap raw API errors.
        Effect.mapError((e) =>
          Schema.is(AuthError)(e)
            ? e
            : AuthError.make({ message: "Cloudflare: could not list accounts", cause: e }),
        ),
      );

      return {
        method: "oauth" as const,
        scopes: [...scopes],
        accountId,
        clientId: oauthCreds.clientId,
        access: Redacted.value(oauthCreds.access),
        refresh: Redacted.value(oauthCreds.refresh),
        expires: oauthCreds.expires,
      };
    });

    const configureInteractive = (profileName: string, currentConfig?: CloudflareAuthConfig) =>
      Interaction.select({ message: "Cloudflare authentication method", options }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("oauth", () => configureOAuth(profileName, currentConfig)),
            Match.when("stored", () => loginStored()),
            Match.exhaustive,
          ),
        ),
      );

    const configureCredentials = (profileName: string, currentConfig?: CloudflareAuthConfig) =>
      Effect.gen(function* () {
        const config = yield* configureInteractive(profileName, currentConfig);
        // Re-configuring auth may point this profile at a different
        // Cloudflare account. The cached state-store credentials
        // (`~/.alchemy/profiles/{profile}/state-stores/cloudflare.json`)
        // are minted per-account, so drop them here; the next deploy
        // re-derives them against the freshly-configured account.
        yield* clearStoreCredentials(store, profileName).pipe(Effect.ignore);
        return config;
      }).pipe(
        // AuthError messages are already user-facing; re-wrapping them in a
        // generic banner is what hid "no accounts visible" behind
        // "failed to configure credentials".
        Effect.mapError((e) =>
          Schema.is(AuthError)(e)
            ? e
            : AuthError.make({ message: "failed to configure credentials", cause: e }),
        ),
      );

    const resolveCredentials = (
      profileName: string,
      config: CloudflareAuthConfig,
      updateConfig?: (config: CloudflareAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Effect.gen(function* () {
        const reauth = refreshHint(CLOUDFLARE_AUTH_PROVIDER_NAME, profileName);
        return yield* Match.value(config).pipe(
          Match.when({ method: "stored", credentialType: "apiToken" }, (c) =>
            validateAccountId(c.accountId, `stored for profile '${profileName}'`).pipe(
              Effect.map((accountId) => ({
                type: "apiToken" as const,
                apiToken: Redacted.make(c.apiToken),
                accountId,
                source: { type: "stored" as const },
              })),
            ),
          ),
          Match.when({ method: "stored", credentialType: "apiKey" }, (c) =>
            validateAccountId(c.accountId, `stored for profile '${profileName}'`).pipe(
              Effect.map((accountId) => ({
                type: "apiKey" as const,
                apiKey: Redacted.make(c.apiKey),
                email: Redacted.make(c.email),
                accountId,
                source: { type: "stored" as const },
              })),
            ),
          ),
          Match.when({ method: "oauth" }, (cfg) =>
            Effect.gen(function* () {
              if (!("scopes" in cfg)) {
                return yield* NeedsReauth.make({
                  provider: CLOUDFLARE_AUTH_PROVIDER_NAME,
                  profile: profileName,
                  message: `Cloudflare OAuth scopes need to be selected. ${reauth}`,
                });
              }
              const accountId = yield* validateAccountId(
                cfg.accountId,
                `configured for profile '${profileName}'`,
              );
              const creds: OAuthClient.OAuthCredentials = {
                type: "oauth",
                clientId: cfg.clientId,
                access: Redacted.make(cfg.access),
                refresh: Redacted.make(cfg.refresh),
                expires: cfg.expires,
                scopes: cfg.scopes,
              };
              // Grants issued to the legacy client keep refreshing against
              // it; only a manual `profile refresh` migrates them.
              const client = OAuthClient.clientFor(creds);
              if (client === undefined) {
                return yield* NeedsReauth.make({
                  provider: CLOUDFLARE_AUTH_PROVIDER_NAME,
                  profile: profileName,
                  message: `Cloudflare OAuth credentials for profile '${profileName}' were issued to an incompatible OAuth client and have been removed. ${reauth}`,
                });
              }
              // Refresh proactively if the token has expired (or is within
              // 10s of expiring). Persist the refreshed creds so subsequent
              // resolves don't repeat the round-trip.
              const now = yield* Clock.currentTimeMillis;
              const fresh =
                creds.expires > now + 10_000
                  ? creds
                  : yield* client.refresh(creds).pipe(
                      Effect.mapError((e) =>
                        NeedsReauth.make({
                          provider: CLOUDFLARE_AUTH_PROVIDER_NAME,
                          profile: profileName,
                          message: `Cloudflare OAuth refresh failed. ${reauth}`,
                          cause: e,
                        }),
                      ),
                    );
              if (fresh !== creds) {
                yield* (
                  updateConfig?.({
                    method: "oauth",
                    accountId,
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
                accountId,
                source: { type: "oauth" as const },
              };
            }),
          ),
          Match.exhaustive,
        );
      });

    const readEnvironment = Effect.gen(function* () {
      const accountId = yield* getEnvRequired("CLOUDFLARE_ACCOUNT_ID").pipe(
        Effect.flatMap((id) => validateAccountId(id, "from CLOUDFLARE_ACCOUNT_ID")),
      );
      const apiToken = yield* getEnvRedacted("CLOUDFLARE_API_TOKEN");
      if (apiToken) {
        return { type: "apiToken" as const, apiToken, accountId, source: { type: "env" as const } };
      }
      const apiKey = yield* getEnvRedacted("CLOUDFLARE_API_KEY");
      const email =
        (yield* getEnvRedacted("CLOUDFLARE_EMAIL")) ??
        (yield* getEnvRedacted("CLOUDFLARE_ACCOUNT_EMAIL"));
      if (apiKey && email) {
        return {
          type: "apiKey" as const,
          apiKey,
          email,
          accountId,
          source: { type: "env" as const },
        };
      }
      return yield* AuthError.make({
        message:
          "Cloudflare CI credentials not found. Set CLOUDFLARE_API_TOKEN, or CLOUDFLARE_API_KEY with CLOUDFLARE_EMAIL/CLOUDFLARE_ACCOUNT_EMAIL.",
      });
    });

    const logout = (profileName: string, config: CloudflareAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "stored" }, () => Effect.void),
        Match.when({ method: "oauth" }, (config) => {
          if (!("scopes" in config)) return Effect.void;
          const credentials: OAuthClient.OAuthCredentials = {
            type: "oauth",
            clientId: config.clientId,
            access: Redacted.make(config.access),
            refresh: Redacted.make(config.refresh),
            expires: config.expires,
            scopes: config.scopes,
          };
          const client = OAuthClient.clientFor(credentials);
          return client !== undefined
            ? client
                .revoke(credentials)
                .pipe(
                  Effect.catchTag("OAuthNetworkError", (err) =>
                    Interaction.warning(`Cloudflare: could not revoke OAuth token: ${err.message}`),
                  ),
                )
            : Effect.void;
        }),
        Match.exhaustive,
        // The cached state-store credentials are derived from the account we
        // just logged out of, so drop them regardless of auth method.
        Effect.andThen(clearStoreCredentials(store, profileName).pipe(Effect.ignore)),
      );

    const login = (
      profileName: string,
      config: CloudflareAuthConfig,
      updateConfig?: (config: CloudflareAuthConfig) => Effect.Effect<void, AuthError>,
      reload?: Effect.Effect<CloudflareAuthConfig, AuthError>,
    ) =>
      Match.value(config).pipe(
        Match.when({ method: "stored" }, (config) => Effect.succeed(config)),
        Match.when({ method: "oauth" }, (c) =>
          "scopes" in c
            ? Effect.gen(function* () {
                const creds: OAuthClient.OAuthCredentials = {
                  type: "oauth",
                  clientId: c.clientId,
                  access: Redacted.make(c.access),
                  refresh: Redacted.make(c.refresh),
                  expires: c.expires,
                  scopes: c.scopes,
                };
                const reconfigure = reconfigureHint(CLOUDFLARE_AUTH_PROVIDER_NAME, profileName);
                // Any path that falls back to a full browser login rebuilds the
                // authorize URL from the profile's stored scopes. Those scopes
                // may predate the current OAuth client (or a catalog change), and
                // one unknown scope makes the whole authorize URL invalid — so
                // sanitize before generating a URL, never after it fails.
                const fullLogin = Effect.gen(function* () {
                  const { valid } = partitionOAuthScopes(c.scopes);
                  if (valid.length === 0) {
                    return yield* AuthError.make({
                      message:
                        `The OAuth scopes stored for profile '${profileName}' are no longer offered by Alchemy's Cloudflare OAuth client. ` +
                        `Scopes must be picked again. ${reconfigure}`,
                    });
                  }
                  const refreshed = yield* oauthLogin(profileName, valid);
                  return {
                    ...c,
                    scopes: valid,
                    clientId: refreshed.clientId,
                    access: Redacted.value(refreshed.access),
                    refresh: Redacted.value(refreshed.refresh),
                    expires: refreshed.expires,
                  };
                });

                // Grants from any other client (including the legacy one) are
                // re-authorized against the current client with the same
                // scopes rather than refreshed.
                const migrateToCurrentClient = Interaction.info(
                  "Cloudflare: re-authorizing OAuth credentials with the new client.",
                ).pipe(Effect.as({ type: "browser" as const }));

                // The silent refresh rotates a single-use refresh token, so
                // its read-refresh-persist section runs under the profile
                // lock — a concurrent `read` refreshing the same token would
                // double-spend it. It refreshes with the token stored now,
                // read under the lock, not the one `config` was read with.
                // The lock is held only for this API round-trip, never
                // across the browser wait below.
                const outcome =
                  creds.type === "oauth" && OAuthClient.usesCurrentClient(creds)
                    ? yield* withProfileCredentialsLock(
                        profileName,
                        Effect.gen(function* () {
                          const current = yield* reload ?? Effect.succeed(c);
                          if (current.method !== "oauth" || !("scopes" in current)) {
                            return { type: "browser" as const };
                          }
                          const currentCredentials: OAuthClient.OAuthCredentials = {
                            type: "oauth",
                            clientId: current.clientId,
                            access: Redacted.make(current.access),
                            refresh: Redacted.make(current.refresh),
                            expires: current.expires,
                            scopes: current.scopes,
                          };
                          if (!OAuthClient.usesCurrentClient(currentCredentials)) {
                            return yield* migrateToCurrentClient;
                          }
                          return yield* Interaction.info(
                            "Cloudflare: refreshing OAuth credentials...",
                          ).pipe(
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
                              // Saved here, under the lock, when the caller can
                              // take it; otherwise handed back for the caller to save.
                              const unsaved: Effect.Effect<typeof config | undefined, AuthError> =
                                updateConfig === undefined
                                  ? Effect.succeed(config)
                                  : Effect.as(updateConfig(config), undefined);
                              return unsaved.pipe(
                                Effect.map((config) => ({ type: "refreshed" as const, config })),
                              );
                            }),
                            Effect.tap(() =>
                              Interaction.success("Cloudflare: OAuth credentials refreshed."),
                            ),
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
                        }),
                      )
                    : yield* migrateToCurrentClient;
                if (outcome.type === "browser") {
                  return yield* fullLogin;
                }
                return outcome.config;
              })
            : configureOAuth(profileName, c),
        ),
        Match.exhaustive,
        // A blanket mapError must never swallow the NeedsReauth tag —
        // the profile UI matches on it to render "needs re-login".
        Effect.mapError((e) =>
          Schema.is(NeedsReauth)(e) ? e : AuthError.make({ message: "login failed", cause: e }),
        ),
      );

    const details = (
      profileName: string,
      config: CloudflareAuthConfig,
      updateConfig?: (config: CloudflareAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Effect.all([
        resolveCredentials(profileName, config, updateConfig),
        Clock.currentTimeMillis,
      ]).pipe(
        Effect.map(([creds, now]) => {
          const resolvedSource: CloudflareResolvedCredentials["source"] = creds.source;
          const source = {
            key: "source",
            value: resolvedSource.details
              ? `${resolvedSource.type} - ${resolvedSource.details}`
              : resolvedSource.type,
          };
          return {
            lines: Match.value(creds).pipe(
              Match.when({ type: "apiToken" }, (c) => [
                { key: "apiToken", value: displayRedacted(c.apiToken, 9) },
                { key: "accountId", value: c.accountId },
                source,
              ]),
              Match.when({ type: "apiKey" }, (c) => [
                { key: "apiKey", value: displayRedacted(c.apiKey) },
                { key: "email", value: displayRedacted(c.email) },
                { key: "accountId", value: c.accountId },
                source,
              ]),
              Match.when({ type: "oauth" }, (c) => {
                const remainingMs = c.expires - now;
                const expiresAt = new Date(c.expires).toISOString();
                const expiresStr =
                  remainingMs <= 0
                    ? `expired (${expiresAt})`
                    : `in ${Duration.format(Duration.millis(remainingMs))} (${expiresAt})`;
                return [
                  { key: "accessToken", value: displayRedacted(c.accessToken) },
                  { key: "expires", value: expiresStr },
                  { key: "accountId", value: c.accountId },
                  source,
                ];
              }),
              Match.exhaustive,
            ),
          };
        }),
      );

    /**
     * Persist flag-provided stored credentials (`--method stored`). Writes
     * the same `cloudflare-stored` file the interactive stored path writes;
     * OAuth is interactive-only and not accepted here.
     */
    const configureWith = (
      profileName: string,
      input: { readonly method: string; readonly values: Record<string, string> },
    ): Effect.Effect<CloudflareAuthConfig, AuthError> => {
      const persist = (config: CloudflareAuthConfig) =>
        clearStoreCredentials(store, profileName).pipe(Effect.ignore, Effect.as(config));
      if (input.method !== "stored") {
        return Effect.fail(
          AuthError.make({
            message: `Cloudflare: unknown method '${input.method}'. Valid methods: stored. (OAuth is interactive-only.)`,
          }),
        );
      }
      return validateFieldValues(CLOUDFLARE_AUTH_PROVIDER_NAME, storedFields, input.values).pipe(
        Effect.flatMap((values) => {
          const accountId = (storedValueText(values.accountId) ?? "").trim().toLowerCase();
          const apiToken = storedSecret(values.apiToken);
          const apiKey = storedSecret(values.apiKey);
          const email = storedValueText(values.email);
          if (apiToken !== undefined && apiKey === undefined && email === undefined) {
            return persist({
              method: "stored",
              credentialType: "apiToken",
              apiToken: Redacted.value(apiToken),
              accountId,
            });
          }
          if (apiToken === undefined && apiKey !== undefined && email !== undefined) {
            return persist({
              method: "stored",
              credentialType: "apiKey",
              apiKey: Redacted.value(apiKey),
              email,
              accountId,
            });
          }
          return Effect.fail(
            AuthError.make({
              message:
                "Cloudflare: pass either --set apiToken=<token>, or both --set apiKey=<key> and --set email=<email>.",
            }),
          );
        }),
      );
    };

    return {
      configSchema: CloudflareAuthConfigSchema,
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
          name: "CLOUDFLARE_ACCOUNT_ID",
          required: true,
          description: "Account the stack deploys into.",
        },
        {
          name: "CLOUDFLARE_API_TOKEN",
          required: true,
          secret: true,
          alternatives: ["CLOUDFLARE_API_KEY"],
          description:
            "API token (preferred). Not consulted when unset and CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL are provided instead.",
        },
        {
          name: "CLOUDFLARE_API_KEY",
          required: false,
          secret: true,
          description: "Global API key; used with CLOUDFLARE_EMAIL when no API token is set.",
        },
        {
          name: "CLOUDFLARE_EMAIL",
          required: false,
          alternatives: ["CLOUDFLARE_ACCOUNT_EMAIL"],
          description: "Account email paired with CLOUDFLARE_API_KEY.",
        },
      ],
    };
  }),
);
