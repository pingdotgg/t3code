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
import { normalizeRelayIssuer, signRelayJwt, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type * as Settings from "./settings.ts";

const LINK_CHALLENGE_TYP = "t3-link-challenge+jwt";
const ACCESS_TOKEN_TYP = "t3-relay-dpop-access+jwt";
const LINK_CHALLENGE_KIND = "environment_link_challenge";

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

const decodeLinkChallengeClaims = Schema.decodeUnknownEffect(LinkChallengeClaims);
const decodeDpopAccessTokenClaims = Schema.decodeUnknownEffect(RelayDpopAccessTokenClaims);

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

export function resolveDpopAccessTokenScopes(input: {
  readonly clientId: RelayPublicClientId;
  readonly scope: string;
}): ReadonlyArray<RelayDpopAccessTokenScope> | null {
  return parseAllowedOAuthScope({
    value: input.scope,
    allowedScopes: allowedScopesByClientId[input.clientId],
  });
}

export function issueLinkChallengeToken(input: {
  readonly settings: Settings.SettingsShape;
  readonly userId: string;
  readonly request: RelayEnvironmentLinkChallengeRequest;
  readonly jti: string;
  readonly issuedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
}) {
  const issuer = normalizeRelayIssuer(input.settings.relayIssuer);
  return signRelayJwt({
    privateKey: Redacted.value(input.settings.cloudMintPrivateKey),
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
}

export function verifyLinkChallengeToken(input: {
  readonly settings: Settings.SettingsShape;
  readonly token: string;
  readonly userId: string;
  readonly request: RelayEnvironmentLinkChallengeRequest;
  readonly nowEpochSeconds: number;
}) {
  const issuer = normalizeRelayIssuer(input.settings.relayIssuer);
  return verifyRelayJwt({
    publicKey: Redacted.value(input.settings.cloudMintPublicKey),
    token: input.token,
    typ: LINK_CHALLENGE_TYP,
    issuer,
    audience: issuer,
    nowEpochSeconds: input.nowEpochSeconds,
  }).pipe(
    Effect.flatMap(decodeLinkChallengeClaims),
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
    Effect.catch(() => Effect.succeed(null)),
  );
}

export function issueDpopAccessToken(input: {
  readonly settings: Settings.SettingsShape;
  readonly userId: string;
  readonly proofKeyThumbprint: string;
  readonly jti: string;
  readonly issuedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  readonly clientId: RelayPublicClientId;
  readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
}) {
  const issuer = normalizeRelayIssuer(input.settings.relayIssuer);
  return signRelayJwt({
    privateKey: Redacted.value(input.settings.cloudMintPrivateKey),
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
}

export function verifyDpopAccessToken(input: {
  readonly settings: Settings.SettingsShape;
  readonly token: string;
  readonly nowEpochSeconds: number;
}) {
  const issuer = normalizeRelayIssuer(input.settings.relayIssuer);
  return verifyRelayJwt({
    publicKey: Redacted.value(input.settings.cloudMintPublicKey),
    token: input.token,
    typ: ACCESS_TOKEN_TYP,
    issuer,
    audience: issuer,
    nowEpochSeconds: input.nowEpochSeconds,
  }).pipe(
    Effect.flatMap(decodeDpopAccessTokenClaims),
    Effect.map((claims) => {
      const scopes = resolveDpopAccessTokenScopes({
        clientId: claims.client_id,
        scope: claims.scope,
      });
      return scopes === null
        ? null
        : ({ ...claims, scope: scopes } satisfies RelayDpopAccessTokenClaims);
    }),
    Effect.catch(() => Effect.succeed(null)),
  );
}
