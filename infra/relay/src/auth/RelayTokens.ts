import {
  RelayDpopAccessTokenScope,
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  RelayMobileClientId,
  RelayMobileRegistrationScope,
  RelayWebClientId,
  type RelayPublicClientId,
  type RelayEnvironmentLinkChallengeRequest,
} from "@t3tools/contracts/relay";
import { encodeOAuthScope, parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import { normalizeRelayIssuer, RelayJwtError } from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import * as CloudMintSigner from "./CloudMintSigner.ts";

const LINK_CHALLENGE_TYP = "t3-link-challenge+jwt";
const ACCESS_TOKEN_TYP = "t3-relay-dpop-access+jwt";
const LINK_CHALLENGE_KIND = "environment_link_challenge";
export const RELAY_DPOP_ACCESS_TOKEN_TTL = "30 minutes";

const LinkChallengeClaims = Schema.Struct({
  kind: Schema.Literal(LINK_CHALLENGE_KIND),
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  jti: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  notificationsEnabled: Schema.Boolean,
  liveActivitiesEnabled: Schema.Boolean,
  managedTunnelsEnabled: Schema.Boolean,
});
export type LinkChallengeClaims = typeof LinkChallengeClaims.Type;

const RelayDpopAccessTokenClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  jti: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  client_id: Schema.Literals([RelayMobileClientId, RelayWebClientId]),
  scope: Schema.String,
  cnf: Schema.Struct({ jkt: Schema.String }),
});
export type RelayDpopAccessTokenClaims = Omit<typeof RelayDpopAccessTokenClaims.Type, "scope"> & {
  readonly scope: ReadonlyArray<RelayDpopAccessTokenScope>;
};

const allowedScopesByClientId: Record<
  RelayPublicClientId,
  ReadonlySet<RelayDpopAccessTokenScope>
> = {
  [RelayMobileClientId]: new Set([
    RelayEnvironmentConnectScope,
    RelayEnvironmentStatusScope,
    RelayMobileRegistrationScope,
  ]),
  [RelayWebClientId]: new Set([RelayEnvironmentConnectScope, RelayEnvironmentStatusScope]),
};

function resolveDpopAccessTokenScopes(input: {
  readonly clientId: RelayPublicClientId;
  readonly scope: string;
}): ReadonlyArray<RelayDpopAccessTokenScope> | null {
  return parseAllowedOAuthScope({
    value: input.scope,
    allowedScopes: allowedScopesByClientId[input.clientId],
  });
}

export class RelayTokens extends Context.Service<
  RelayTokens,
  {
    readonly resolveDpopAccessTokenScopes: typeof resolveDpopAccessTokenScopes;
    readonly issueLinkChallenge: (input: {
      readonly userId: string;
      readonly request: RelayEnvironmentLinkChallengeRequest;
      readonly jti: string;
      readonly issuedAtEpochSeconds: number;
      readonly expiresAtEpochSeconds: number;
    }) => Effect.Effect<string, RelayJwtError>;
    readonly verifyLinkChallenge: (input: {
      readonly token: string;
      readonly userId: string;
      readonly request: RelayEnvironmentLinkChallengeRequest;
    }) => Effect.Effect<LinkChallengeClaims | null>;
    readonly issueDpopAccessToken: (input: {
      readonly userId: string;
      readonly proofKeyThumbprint: string;
      readonly jti: string;
      readonly issuedAtEpochSeconds: number;
      readonly expiresAtEpochSeconds: number;
      readonly clientId: RelayPublicClientId;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    }) => Effect.Effect<string, RelayJwtError>;
    readonly verifyDpopAccessToken: (input: {
      readonly token: string;
    }) => Effect.Effect<RelayDpopAccessTokenClaims | null>;
  }
>()("t3code-relay/auth/RelayTokens") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const issuer = normalizeRelayIssuer(config.relayIssuer);
  const mint = yield* CloudMintSigner.CloudMintSigner;

  const issueLinkChallenge: RelayTokens["Service"]["issueLinkChallenge"] = Effect.fn(
    "relay.tokens.issue_link_challenge",
  )(function* (input) {
    return yield* mint.sign({
      typ: LINK_CHALLENGE_TYP,
      payload: {
        kind: LINK_CHALLENGE_KIND,
        iss: issuer,
        aud: issuer,
        sub: input.userId,
        jti: input.jti,
        iat: input.issuedAtEpochSeconds,
        exp: input.expiresAtEpochSeconds,
        ...input.request,
      },
    });
  });

  const verifyLinkChallenge: RelayTokens["Service"]["verifyLinkChallenge"] = Effect.fn(
    "relay.tokens.verify_link_challenge",
  )((input) =>
    mint
      .verify(LinkChallengeClaims, {
        token: input.token,
        typ: LINK_CHALLENGE_TYP,
        issuer,
        audience: issuer,
      })
      .pipe(
        Effect.map((claims) => {
          if (
            claims.sub !== input.userId ||
            (input.request.notificationsEnabled && claims.notificationsEnabled !== true) ||
            (input.request.liveActivitiesEnabled && claims.liveActivitiesEnabled !== true) ||
            (input.request.managedTunnelsEnabled && claims.managedTunnelsEnabled !== true)
          ) {
            return null;
          }
          return claims;
        }),
        Effect.orElseSucceed(() => null),
      ),
  );

  const issueDpopAccessToken: RelayTokens["Service"]["issueDpopAccessToken"] = Effect.fn(
    "relay.tokens.issue_dpop_access_token",
  )(function* (input) {
    return yield* mint.sign({
      typ: ACCESS_TOKEN_TYP,
      payload: {
        iss: issuer,
        aud: issuer,
        sub: input.userId,
        jti: input.jti,
        iat: input.issuedAtEpochSeconds,
        exp: input.expiresAtEpochSeconds,
        client_id: input.clientId,
        scope: encodeOAuthScope(input.scopes),
        cnf: { jkt: input.proofKeyThumbprint },
      },
    });
  });

  const verifyDpopAccessToken: RelayTokens["Service"]["verifyDpopAccessToken"] = Effect.fn(
    "relay.tokens.verify_dpop_access_token",
  )((input) =>
    mint
      .verify(RelayDpopAccessTokenClaims, {
        token: input.token,
        typ: ACCESS_TOKEN_TYP,
        issuer,
        audience: issuer,
        maxTokenAge: RELAY_DPOP_ACCESS_TOKEN_TTL,
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan(
            "relay.tokens.verification_failure",
            RelayJwtError.diagnosticCode(error),
          ),
        ),
        Effect.map((claims): RelayDpopAccessTokenClaims | null => {
          const scopes = resolveDpopAccessTokenScopes({
            clientId: claims.client_id,
            scope: claims.scope,
          });
          return scopes === null ? null : { ...claims, scope: scopes };
        }),
        Effect.orElseSucceed(() => null),
      ),
  );

  return RelayTokens.of({
    resolveDpopAccessTokenScopes,
    issueLinkChallenge,
    verifyLinkChallenge,
    issueDpopAccessToken,
    verifyDpopAccessToken,
  });
});

export const layer = Layer.effect(RelayTokens, make);
