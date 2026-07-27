import * as PsCredentialsModule from "@distilled.cloud/planetscale/Credentials";
import { listOrganizations } from "@distilled.cloud/planetscale/Operations";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import {
  getEnvRedactedRequired,
  getEnvRequired,
  retryOnce,
} from "../Auth/Env.ts";
import * as Clank from "../Util/Clank.ts";
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
const withOAuthCredentials = <A, E>(
  accessToken: string,
  effect: Effect.Effect<
    A,
    E,
    PsCredentialsModule.Credentials | HttpClient.HttpClient
  >,
): Effect.Effect<A, E> =>
  Effect.provide(
    effect,
    Layer.mergeAll(
      PsCredentialsModule.fromOAuth({
        accessToken,
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
      return yield* new AuthError({
        message: "Planetscale: no organizations found for this credential.",
      });
    }
    if (orgs.length === 1) {
      const org = orgs[0]!;
      yield* Clank.info(
        `Planetscale: using organization: ${org.name} (${org.id})`,
      );
      return org.name;
    }
    return yield* Clank.select({
      message: "Select a Planetscale organization",
      options: orgs.map((o) => ({
        value: o.name,
        label: o.name,
        hint: o.id,
      })),
    }).pipe(retryOnce);
  }).pipe((e) => withOAuthCredentials(accessToken, e));

const options: Array<{
  value: PlanetscaleAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variables",
    hint: "PLANETSCALE_API_TOKEN_ID + PLANETSCALE_API_TOKEN + PLANETSCALE_ORGANIZATION",
  },
  {
    value: "oauth",
    label: "OAuth",
    hint: "recommended — browser-based login with automatic token refresh",
  },
  {
    value: "stored",
    label: "Service Token",
    hint: "enter service token interactively, stored in ~/.alchemy/credentials",
  },
];

/**
 * Auth configuration persisted in `~/.alchemy/profiles.json` for the
 * PlanetScale provider.
 *
 * - `env`: read credentials from environment variables at resolution time.
 * - `stored`: read service-token credentials from
 *   `~/.alchemy/credentials/<profile>/planetscale-stored.json`.
 * - `oauth`: browser-based login; the access/refresh tokens are stored at
 *   `~/.alchemy/credentials/<profile>/planetscale-oauth.json` and refreshed
 *   on demand. PlanetScale has no PKCE flow, so the OAuth application's
 *   `client_secret` ships in the CLI — see {@link OAuthClient}.
 */
export type PlanetscaleAuthConfig =
  | { method: "env" }
  | { method: "stored" }
  | { method: "oauth"; organization: string };

/**
 * apiToken credentials persisted to disk for `method: "stored"`.
 * Stored under the file key `"planetscale-stored"`.
 */
export interface PlanetscaleStoredCredentials {
  type: "apiToken";
  tokenId: string;
  token: string;
  organization: string;
}

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
        type: PlanetscaleAuthConfig["method"];
        details?: string;
      };
    }
  | {
      type: "oauth";
      accessToken: Redacted.Redacted<string>;
      expires: number;
      organization: string;
      source: {
        type: PlanetscaleAuthConfig["method"];
        details?: string;
      };
    };

/**
 * Layer that registers the PlanetScale {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the
 * PlanetScale `providers()` layer so `alchemy login` can discover it.
 *
 * Supported methods:
 * - `env`: reads `PLANETSCALE_API_TOKEN_ID`/`PLANETSCALE_API_TOKEN`/`PLANETSCALE_ORGANIZATION`.
 * - `stored`: prompts for a service token interactively and writes it to
 *   `~/.alchemy/credentials/<profile>/planetscale-stored.json`.
 * - `oauth`: browser-based login storing access/refresh tokens at
 *   `~/.alchemy/credentials/<profile>/planetscale-oauth.json`.
 */
export const PlanetscaleAuth = AuthProviderLayer<
  PlanetscaleAuthConfig,
  PlanetscaleResolvedCredentials
>()(
  PLANETSCALE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;

    const oauthLogin = (profileName: string) =>
      Effect.gen(function* () {
        const authorization = OAuthClient.authorize();

        yield* Clank.info("Planetscale: opening browser for OAuth login...");
        yield* Clank.info(authorization.url);
        yield* Clank.openUrl(authorization.url).pipe(
          Effect.catch(() =>
            Clank.warn(
              "Planetscale: could not open browser automatically. Please open the URL above manually.",
            ),
          ),
        );
        yield* Clank.info(
          "Planetscale: waiting for authorization (up to 5 minutes)...",
        );

        const credentials = yield* OAuthClient.callback(authorization);
        yield* store.write(profileName, "planetscale-oauth", credentials);
        yield* Clank.success("Planetscale: OAuth credentials saved.");
        return credentials;
      });

    const configureOAuth = Effect.fn(function* (profileName: string) {
      const oauthCreds = yield* oauthLogin(profileName);

      // Use the just-issued access token to list the user's orgs and let
      // them pick (mirrors Cloudflare's selectAccount). Requires the
      // `user:read_organizations` scope. If the call fails for any
      // reason — missing scope, network, off-spec response — fall back
      // to a manual prompt so login still completes.
      const organization = yield* selectOrganization(oauthCreds.access).pipe(
        Effect.catch((e) =>
          Effect.gen(function* () {
            yield* Clank.warn(
              `Planetscale: could not auto-list organizations (${String(e)}). Falling back to manual entry.`,
            );
            return yield* Clank.text({
              message: "Planetscale Organization (URL slug)",
              validate: (v) => (v.length === 0 ? "Required" : undefined),
            }).pipe(retryOnce);
          }),
        ),
      );

      return { method: "oauth" as const, organization };
    });

    const loginStored = Effect.fn(function* (profileName: string) {
      const tokenId = yield* Clank.text({
        message: "Planetscale Service Token ID",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const token = yield* Clank.password({
        message: "Planetscale Service Token",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const organization = yield* Clank.text({
        message: "Planetscale Organization (URL slug)",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      yield* store.write<PlanetscaleStoredCredentials>(
        profileName,
        "planetscale-stored",
        {
          type: "apiToken",
          tokenId,
          token,
          organization,
        },
      );
      yield* Clank.success("Planetscale: credentials saved.");
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "Planetscale authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("oauth", () => configureOAuth(profileName)),
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
      config: PlanetscaleAuthConfig,
    ): Effect.Effect<PlanetscaleResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when(
          { method: "env" },
          Effect.fn(function* () {
            const tokenId = yield* getEnvRedactedRequired(
              "PLANETSCALE_API_TOKEN_ID",
            );
            const token = yield* getEnvRedactedRequired(
              "PLANETSCALE_API_TOKEN",
            );
            const organization = yield* getEnvRequired(
              "PLANETSCALE_ORGANIZATION",
            );

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
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store
            .read<PlanetscaleStoredCredentials>(
              profileName,
              "planetscale-stored",
            )
            .pipe(
              Effect.flatMap((creds) =>
                creds == null
                  ? Effect.fail(
                      new AuthError({
                        message:
                          "Planetscale stored credentials not found. Run: alchemy login --configure",
                      }),
                    )
                  : Effect.succeed({
                      type: "apiToken" as const,
                      tokenId: Redacted.make(creds.tokenId),
                      token: Redacted.make(creds.token),
                      organization: creds.organization,
                      source: {
                        type: "stored" as const,
                        details: undefined,
                      },
                    } satisfies PlanetscaleResolvedCredentials),
              ),
            ),
        ),
        Match.when({ method: "oauth" }, (cfg) =>
          Effect.gen(function* () {
            const creds = yield* store.read<OAuthClient.OAuthCredentials>(
              profileName,
              "planetscale-oauth",
            );
            if (creds == null || creds.type !== "oauth") {
              return yield* Effect.fail(
                new AuthError({
                  message:
                    "Planetscale OAuth credentials not found. Run: alchemy login",
                }),
              );
            }
            // Refresh proactively if the token has expired (or is within
            // 10s of expiring). Persist the refreshed creds so subsequent
            // resolves don't repeat the round-trip.
            const fresh =
              creds.expires > Date.now() + 10_000
                ? creds
                : yield* OAuthClient.refresh(creds).pipe(
                    Effect.tap((refreshed) =>
                      store.write(profileName, "planetscale-oauth", refreshed),
                    ),
                    Effect.mapError(
                      (e) =>
                        new AuthError({
                          message:
                            "Planetscale OAuth refresh failed. Run: alchemy login",
                          cause: e,
                        }),
                    ),
                  );
            return {
              type: "oauth" as const,
              accessToken: Redacted.make(fresh.access),
              expires: fresh.expires,
              organization: cfg.organization,
              source: { type: "oauth" as const },
            } satisfies PlanetscaleResolvedCredentials;
          }),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: PlanetscaleAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, "planetscale-stored")
            .pipe(
              Effect.andThen(
                Clank.success("Planetscale: stored credentials removed"),
              ),
            ),
        ),
        // PlanetScale publishes no token-revocation endpoint, so logout just
        // drops the locally stored tokens.
        Match.when({ method: "oauth" }, () =>
          store
            .delete(profileName, "planetscale-oauth")
            .pipe(
              Effect.andThen(
                Clank.success("Planetscale: OAuth credentials removed."),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: PlanetscaleAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () => Effect.void),
          Match.when({ method: "stored" }, () =>
            store
              .read<PlanetscaleStoredCredentials>(
                profileName,
                "planetscale-stored",
              )
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
                ),
              ),
          ),
          Match.when({ method: "oauth" }, (c) =>
            Effect.gen(function* () {
              const creds = yield* store.read<OAuthClient.OAuthCredentials>(
                profileName,
                "planetscale-oauth",
              );

              if (creds?.type === "oauth") {
                yield* Clank.info(
                  "Planetscale: refreshing OAuth credentials...",
                );
                yield* OAuthClient.refresh(creds).pipe(
                  Effect.flatMap((refreshed) =>
                    store
                      .write(profileName, "planetscale-oauth", refreshed)
                      .pipe(
                        Effect.andThen(
                          Clank.success(
                            "Planetscale: OAuth credentials refreshed.",
                          ),
                        ),
                      ),
                  ),
                  Effect.catchTag("OAuthError", () =>
                    oauthLogin(profileName).pipe(Effect.asVoid),
                  ),
                );
                return;
              }

              yield* oauthLogin(profileName);
            }),
          ),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError(
            (e) => new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const prettyPrint = (profileName: string, config: PlanetscaleAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Match.value(creds).pipe(
            Match.when({ type: "apiToken" }, (c) =>
              Effect.all([
                Console.log(`  tokenId: ${displayRedacted(c.tokenId, 3)}`),
                Console.log(`  token: ${displayRedacted(c.token, 6)}`),
                Console.log(`  organization: ${c.organization}`),
                Console.log(`  source: ${sourceStr}`),
              ]),
            ),
            Match.when({ type: "oauth" }, (c) => {
              const remainingMs = c.expires - Date.now();
              const expiresAt = new Date(c.expires).toISOString();
              const expiresStr =
                remainingMs <= 0
                  ? `expired (${expiresAt})`
                  : `in ${Duration.format(Duration.millis(remainingMs))} (${expiresAt})`;
              return Effect.all([
                Console.log(`  accessToken: ${displayRedacted(c.accessToken)}`),
                Console.log(`  expires: ${expiresStr}`),
                Console.log(`  organization: ${c.organization}`),
                Console.log(`  source: ${sourceStr}`),
              ]);
            }),
            Match.exhaustive,
          );
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
