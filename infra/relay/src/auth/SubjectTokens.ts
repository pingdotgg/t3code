import { createClerkClient, verifyToken } from "@clerk/backend";
import { decodeIdTokenClaims, oidcDiscoveryUrl } from "@t3tools/shared/oidc";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Signature from "effect/crypto/Signature";
import * as Jwks from "effect/jose/Jwks";
import * as Jwt from "effect/jose/Jwt";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type * as RelayConfiguration from "../Config.ts";

export class SubjectTokenVerificationFailed extends Schema.TaggedError<SubjectTokenVerificationFailed>()(
  "SubjectTokenVerificationFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Subject token verification failed";
  }
}

export type SubjectTokenMode = "clerk_session_bearer" | "clerk_oauth_bearer" | "oidc_bearer";

export interface VerifiedSubject {
  readonly sub: string;
  readonly mode: SubjectTokenMode;
}

const OIDC_ACCOUNT_PREFIX = "oidc:";
// Issuers are URLs and cannot contain a raw "|", so the first one always ends the issuer.
export const oidcAccountId = (issuer: string, subject: string): string =>
  `${OIDC_ACCOUNT_PREFIX}${issuer}|${subject}`;
export const isOidcAccountId = (accountId: string): boolean =>
  accountId.startsWith(OIDC_ACCOUNT_PREFIX);

const OIDC_ALGORITHMS = ["RS256", "ES256", "EdDSA"] as const;
const OIDC_DISCOVERY_TIMEOUT = "10 seconds";

const OidcDiscoveryDocument = Schema.Struct({
  issuer: Schema.String,
  jwks_uri: Schema.String,
});
const decodeOidcDiscoveryDocument = Schema.decodeUnknownEffect(OidcDiscoveryDocument);
const isSubjectTokenVerificationFailed = Schema.is(SubjectTokenVerificationFailed);

/**
 * Discovers the issuer's key set once; `Jwks` then refetches it on its own TTL and on unknown keys.
 * The issuer must match the configured string exactly, including a path prefix or trailing slash;
 * a reverse proxy that rewrites the public origin should be reflected in the configured issuer.
 */
export const makeOidcKeySet = Effect.fn("relay.auth.make_oidc_key_set")(function* (issuer: string) {
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  const discover = Effect.gen(function* () {
    const response = yield* httpClient.execute(HttpClientRequest.get(oidcDiscoveryUrl(issuer)));
    if (response.status !== 200) {
      return yield* new SubjectTokenVerificationFailed({
        cause: `oidc_discovery_status_${response.status}`,
      });
    }
    const document = yield* response.json.pipe(Effect.flatMap(decodeOidcDiscoveryDocument));
    if (document.issuer !== issuer) {
      return yield* new SubjectTokenVerificationFailed({ cause: "oidc_issuer_mismatch" });
    }
    return yield* Jwks.makeRemote({ url: document.jwks_uri }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(Scope.Scope, scope),
    );
  });
  return yield* Effect.cachedInvalidateWithTTL(
    discover.pipe(
      Effect.timeout(OIDC_DISCOVERY_TIMEOUT),
      Effect.mapError((cause) =>
        isSubjectTokenVerificationFailed(cause)
          ? cause
          : new SubjectTokenVerificationFailed({ cause }),
      ),
    ),
    (exit) => (Exit.isSuccess(exit) ? Duration.infinity : "1 minute"),
  );
});

const readUnverifiedIssuer = (token: string): string | undefined => {
  try {
    return decodeIdTokenClaims(token).iss;
  } catch {
    return undefined;
  }
};

const OidcClaims = Schema.Struct({ sub: Schema.NonEmptyString });

/** Binds the crypto service at startup, since the auth middleware cannot require services. */
export const makeOidcVerifier = Effect.fn("relay.auth.make_oidc_verifier")(function* (options: {
  readonly issuer: string;
  readonly audience: string;
  readonly keySet: Effect.Effect<Jwks.Jwks["Service"], SubjectTokenVerificationFailed>;
}) {
  const signature = yield* Signature.Signature;
  return (token: string): Effect.Effect<VerifiedSubject, SubjectTokenVerificationFailed> =>
    options.keySet.pipe(
      Effect.flatMap((keySet) =>
        Jwt.verifyWithKeySet(OidcClaims, token, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: OIDC_ALGORITHMS,
          requiredClaims: ["exp"],
          // The identity provider and the relay run on different clocks.
          clockTolerance: "5 seconds",
        }).pipe(
          Effect.provideService(Jwks.Jwks, keySet),
          Effect.provideService(Signature.Signature, signature),
          Effect.mapError((cause) => new SubjectTokenVerificationFailed({ cause })),
        ),
      ),
      Effect.map(({ claims }): VerifiedSubject => ({
        sub: oidcAccountId(options.issuer, claims.sub),
        mode: "oidc_bearer",
      })),
      Effect.withSpan("relay.auth.verify_oidc_token"),
    );
});

interface ClerkSettings {
  readonly secretKey: Redacted.Redacted<string>;
  readonly publishableKey: string;
  readonly audience: string;
}

const clerkSettingsFrom = (
  config: RelayConfiguration.RelayConfiguration["Service"],
): ClerkSettings | undefined =>
  config.clerkSecretKey === undefined ||
  config.clerkPublishableKey === undefined ||
  config.clerkJwtAudience === undefined
    ? undefined
    : {
        secretKey: config.clerkSecretKey,
        publishableKey: config.clerkPublishableKey,
        audience: config.clerkJwtAudience,
      };

const hasExpectedClerkAudience = (audience: unknown, expectedAudience: string): boolean =>
  typeof audience === "string"
    ? audience === expectedAudience
    : Array.isArray(audience) &&
      audience.some((entry) => typeof entry === "string" && entry === expectedAudience);

const verifyClerkSessionToken = (clerk: ClerkSettings, token: string) =>
  Effect.tryPromise({
    try: () =>
      verifyToken(token, {
        secretKey: Redacted.value(clerk.secretKey),
        audience: clerk.audience,
      }),
    catch: (cause) => new SubjectTokenVerificationFailed({ cause }),
  }).pipe(
    Effect.withSpan("verify_clerk_bearer_token", {
      attributes: { "relay.auth.token_length": token.length },
    }),
    Effect.flatMap((verified) =>
      verified.sub && hasExpectedClerkAudience(verified.aud, clerk.audience)
        ? Effect.succeed({
            sub: verified.sub,
            mode: "clerk_session_bearer",
          } satisfies VerifiedSubject)
        : Effect.fail(new SubjectTokenVerificationFailed({ cause: "missing_relay_audience" })),
    ),
  );

const verifyClerkOAuthToken = (clerk: ClerkSettings, relayIssuer: string, token: string) =>
  Effect.tryPromise({
    try: async () => {
      const client = createClerkClient({
        secretKey: Redacted.value(clerk.secretKey),
        publishableKey: clerk.publishableKey,
      });
      const state = await client.authenticateRequest(
        new Request(relayIssuer, {
          headers: { authorization: `Bearer ${token}` },
        }),
        { acceptsToken: "oauth_token" },
      );
      const auth = state.toAuth();
      if (!state.isAuthenticated || !auth.userId) {
        throw new Error("Clerk OAuth token is not authenticated.");
      }
      return { sub: auth.userId, mode: "clerk_oauth_bearer" } satisfies VerifiedSubject;
    },
    catch: (cause) => new SubjectTokenVerificationFailed({ cause }),
  });

/**
 * Tokens from the configured OIDC issuer are verified against its keys. Anything else is treated
 * as Clerk, so existing Clerk accounts keep their subject ids unchanged.
 */
export const verifySubjectToken = (
  config: RelayConfiguration.RelayConfiguration["Service"],
  token: string,
  options: { readonly acceptClerkOAuth: boolean },
): Effect.Effect<VerifiedSubject, SubjectTokenVerificationFailed> => {
  const oidc = config.oidc;
  if (oidc && readUnverifiedIssuer(token) === oidc.issuer) {
    return oidc.verify(token);
  }
  const clerk = clerkSettingsFrom(config);
  if (clerk === undefined) {
    return Effect.fail(new SubjectTokenVerificationFailed({ cause: "clerk_not_configured" }));
  }
  const session = verifyClerkSessionToken(clerk, token);
  return options.acceptClerkOAuth
    ? session.pipe(Effect.catch(() => verifyClerkOAuthToken(clerk, config.relayIssuer, token)))
    : session;
};
