import {
  AuthSessionId,
  AuthStandardClientScopes,
  AuthEnvironmentScopes,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthEnvironmentScope,
  AuthWebSocketTicketUse,
  RuntimeMode,
  type ServerAuthSessionMethod,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  REUSABLE_DEV_SESSION_EXPIRES_AT,
  REUSABLE_DEV_SESSION_PREFIX,
  resolveReusableDevAuth,
} from "./ReusableDevAuth.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  resolveLegacySessionCookieName,
  resolveSessionCookieName,
  signPayload,
  timingSafeEqualBase64Url,
} from "./utils.ts";
import { toClientMetadata } from "./SessionStoreParts.ts";
import {
  ActiveSessionsListError,
  InvalidSessionExpirationClaimError,
  InvalidSessionTokenPayloadError,
  InvalidSessionTokenSignatureError,
  InvalidWebSocketTokenPayloadError,
  InvalidWebSocketTokenSignatureError,
  MalformedSessionTokenError,
  MalformedWebSocketTokenError,
  OtherSessionsRevocationError,
  SessionClaimsEncodingError,
  SessionCredentialIssueError,
  SessionCredentialVerificationError,
  SessionRevocationError,
  SessionTokenExpiredError,
  SessionTokenRevokedError,
  UnknownSessionTokenError,
  UnknownWebSocketSessionError,
  WebSocketSessionExpiredError,
  WebSocketSessionRevokedError,
  WebSocketTokenExpiredError,
  WebSocketTokenIssueError,
  WebSocketTokenVerificationError,
} from "./SessionStoreErrors.ts";
import {
  SessionCredentialError,
} from "./SessionStoreErrors.ts";
import type {
  IssuedSession,
  SessionCredentialChange,
  SessionCredentialInternalError,
  SessionCredentialInvalidError,
  VerifiedSession,
  VerifiedWebSocketTicket,
} from "./SessionStoreErrors.ts";

export const SIGNING_SECRET_NAME = "server-signing-key";
export const DEFAULT_SESSION_TTL = Duration.days(30);
export const DEFAULT_WEBSOCKET_TOKEN_TTL = Duration.minutes(5);

export const SessionClaims = Schema.Struct({
  v: Schema.Literals([1, 2]),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: Schema.Literals(["browser-session-cookie", "bearer-access-token", "dpop-access-token"]),
  jkt: Schema.optionalKey(Schema.String),
  rtc: Schema.optionalKey(RuntimeMode),
  /** Signed, so a client cannot shed its peer link's limits. */
  plk: Schema.optionalKey(Schema.Literal(1)),
  iat: Schema.Number,
  exp: Schema.Number,
});
export type SessionClaims = typeof SessionClaims.Type;

export const WebSocketClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("websocket"),
  sid: AuthSessionId,
  aud: Schema.optionalKey(AuthWebSocketTicketUse),
  jkt: Schema.optionalKey(Schema.String),
  iat: Schema.Number,
  exp: Schema.Number,
});
export type WebSocketClaims = typeof WebSocketClaims.Type;

export const decodeSessionClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionClaims));
export const decodeWebSocketClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(WebSocketClaims));

export function createDefaultClientMetadata(): AuthClientMetadata {
  return {
    deviceType: "unknown",
  };
}

export function toAuthClientSession(input: Omit<AuthClientSession, "current">): AuthClientSession {
  return {
    ...input,
    current: false,
  };
}

