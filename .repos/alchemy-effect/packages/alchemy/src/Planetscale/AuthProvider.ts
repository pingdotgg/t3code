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
import {
  getEnvRedactedRequired,
  getEnvRequired,
  retryOnce,
} from "../Auth/Env.ts";
import * as Clank from "../Util/Clank.ts";

/**
 * Canonical name registered in {@link AuthProviders}. Use this key to look
 * up the PlanetScale {@link AuthProvider} from inside provider Layers.
 */
export const PLANETSCALE_AUTH_PROVIDER_NAME = "Planetscale";

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
    value: "stored",
    label: "Service Token",
    hint: "enter service token interactively, stored in ~/.alchemy/credentials",
  },
  //todo(pear): add planetscale oauth
];

/**
 * Auth configuration persisted in `~/.alchemy/profiles.json` for the
 * PlanetScale provider.
 *
 * - `env`: read credentials from environment variables at resolution time.
 * - `stored`: read credentials from `~/.alchemy/credentials/<profile>/planetscale-stored.json`.
 *
 * OAuth is intentionally not implemented because PlanetScale does not
 * publish a redirect-based OAuth client; service tokens are the canonical
 * credential.
 */
export type PlanetscaleAuthConfig = { method: "env" } | { method: "stored" };

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
 * {@link AuthProviderImpl.read}.
 */
export interface PlanetscaleResolvedCredentials {
  type: "apiToken";
  tokenId: Redacted.Redacted<string>;
  token: Redacted.Redacted<string>;
  organization: string;
  source: {
    type: PlanetscaleAuthConfig["method"];
    details?: string;
  };
}

/**
 * Layer that registers the PlanetScale {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the
 * PlanetScale `providers()` layer so `alchemy login` can discover it.
 *
 * Supported methods:
 * - `env`: reads `PLANETSCALE_API_TOKEN_ID`/`PLANETSCALE_API_TOKEN`/`PLANETSCALE_ORGANIZATION`.
 * - `stored`: prompts for a service token interactively and writes it to
 *   `~/.alchemy/credentials/<profile>/planetscale-stored.json`.
 */
export const PlanetscaleAuth = AuthProviderLayer<
  PlanetscaleAuthConfig,
  PlanetscaleResolvedCredentials
>()(
  PLANETSCALE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;

    const loginStored = Effect.fnUntraced(function* (profileName: string) {
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
          Effect.fnUntraced(function* () {
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
          return Effect.all([
            Console.log(`  tokenId: ${displayRedacted(creds.token, 3)}`),
            Console.log(`  token: ${displayRedacted(creds.token, 6)}`),
            Console.log(`  organization: ${creds.organization}`),
            Console.log(`  source: ${sourceStr}`),
          ]);
        }),
        Effect.catch((e) =>
          Console.error(`  Failed to retrieve credentials: ${e}`),
        ),
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
