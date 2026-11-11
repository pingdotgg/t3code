import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/turso/Credentials";
import * as turso from "@distilled.cloud/turso/turso";
import { lazyCredentials, orDieCredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { TURSO_AUTH_PROVIDER_NAME, type TursoResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/turso/Credentials";

/**
 * The Turso organization slug every org-scoped Platform API call targets.
 * Holds an effect so the slug is resolved (and, when not configured,
 * discovered from the API token) on first use, never at layer build.
 */
export class Organization extends Context.Service<Organization, Effect.Effect<string>>()(
  "Turso.Organization",
) {}

/** The organization slug for the current Turso credentials. */
export const organization = Effect.gen(function* () {
  return yield* yield* Organization;
});

/**
 * Discover the organization an API token acts on: the token's own
 * organization when it is org-scoped, else the account's only organization.
 */
const discoverOrganization = Effect.gen(function* () {
  const orgs = yield* turso.listOrganizations({});
  if (orgs.length === 1 && orgs[0]?.slug) {
    return orgs[0].slug;
  }
  return yield* new ConfigError({
    message:
      orgs.length === 0
        ? "Turso: this API token has no organizations."
        : `Turso: this API token can access ${orgs.length} organizations (${orgs
            .map((org) => org.slug)
            .join(", ")}). Set TURSO_ORGANIZATION or configure the organization in your profile.`,
  });
});

const make = (
  resolve: Effect.Effect<TursoResolvedCredentials, ConfigError>,
): Effect.Effect<Context.Context<Credentials | Organization>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const credentials = Effect.map(resolve, (creds) => ({
      apiKey: creds.apiToken,
      apiBaseUrl: creds.apiBaseUrl,
    }));
    // `Organization` is typed as never failing, so a credentials failure dies
    // here; the engine still reports it as `CredentialsRequired`.
    const organization = yield* resolve.pipe(
      Effect.orDie,
      Effect.flatMap((creds) =>
        creds.organization !== undefined && creds.organization.length > 0
          ? Effect.succeed(creds.organization)
          : discoverOrganization.pipe(
              Effect.provideService(Credentials, credentials),
              Effect.provideService(HttpClient.HttpClient, http),
              orDieCredentialsUnavailable(TURSO_AUTH_PROVIDER_NAME),
            ),
      ),
      Effect.cached,
    );
    return Context.make(Credentials, credentials).pipe(Context.add(Organization, organization));
  });

/**
 * Build Turso `Credentials` + `Organization` from an explicit API token.
 * Useful for tests or when the caller already has a token in hand.
 *
 * @example
 * ```ts
 * Effect.provide(Turso.fromToken({ apiToken: "...", organization: "my-org" }))
 * ```
 */
export const fromToken = (input: {
  apiToken: string | Redacted.Redacted<string>;
  organization?: string;
  apiBaseUrl?: string;
}) =>
  Effect.succeed<TursoResolvedCredentials>({
    type: "apiToken",
    apiToken: typeof input.apiToken === "string" ? Redacted.make(input.apiToken) : input.apiToken,
    apiBaseUrl: input.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    organization: input.organization,
    source: { type: "stored" },
  }).pipe(make, Layer.effectContext);

/**
 * Build Turso `Credentials` + `Organization` that resolve through the
 * Alchemy AuthProvider: environment credentials (`TURSO_API_TOKEN`) when
 * present, otherwise the selected profile. Resolution is deferred until the
 * first API call, so building the provider layers never needs a profile.
 */
export const fromAuthProvider = () =>
  Layer.effectContext(
    lazyCredentials<TursoResolvedCredentials, ConfigError>()(
      TURSO_AUTH_PROVIDER_NAME,
      (creds) => creds,
    ).pipe(Effect.flatMap(make)),
  );
