import {
  AuthSessionId,
  AuthStandardClientScopes,
  AuthEnvironmentScopes,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type ServerAuthSessionMethod,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  resolveSessionCookieName,
  signPayload,
  timingSafeEqualBase64Url,
} from "./utils.ts";

export interface IssuedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.DateTime;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
}

export interface VerifiedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt?: DateTime.DateTime;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
}

export type SessionCredentialChange =
  | {
      readonly type: "clientUpserted";
      readonly clientSession: AuthClientSession;
    }
  | {
      readonly type: "clientRemoved";
      readonly sessionId: AuthSessionId;
    };

const sessionCredentialInvalidErrorContext = {
  cause: Schema.optional(Schema.Defect()),
};

export class MalformedSessionTokenError extends Schema.TaggedErrorClass<MalformedSessionTokenError>()(
  "MalformedSessionTokenError",
  {
    reason: Schema.Literal("malformed_session_token"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Malformed session token.";
  }
}

export class InvalidSessionTokenSignatureError extends Schema.TaggedErrorClass<InvalidSessionTokenSignatureError>()(
  "InvalidSessionTokenSignatureError",
  {
    reason: Schema.Literal("invalid_session_token_signature"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Invalid session token signature.";
  }
}

export class InvalidSessionTokenPayloadError extends Schema.TaggedErrorClass<InvalidSessionTokenPayloadError>()(
  "InvalidSessionTokenPayloadError",
  {
    reason: Schema.Literal("invalid_session_token_payload"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Invalid session token payload.";
  }
}

export class SessionTokenExpiredError extends Schema.TaggedErrorClass<SessionTokenExpiredError>()(
  "SessionTokenExpiredError",
  {
    reason: Schema.Literal("session_token_expired"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Session token expired.";
  }
}

export class UnknownSessionTokenError extends Schema.TaggedErrorClass<UnknownSessionTokenError>()(
  "UnknownSessionTokenError",
  {
    reason: Schema.Literal("unknown_session_token"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Unknown session token.";
  }
}

export class SessionTokenRevokedError extends Schema.TaggedErrorClass<SessionTokenRevokedError>()(
  "SessionTokenRevokedError",
  {
    reason: Schema.Literal("session_token_revoked"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Session token revoked.";
  }
}

export class InvalidSessionExpirationClaimError extends Schema.TaggedErrorClass<InvalidSessionExpirationClaimError>()(
  "InvalidSessionExpirationClaimError",
  {
    reason: Schema.Literal("invalid_session_exp_claim"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Invalid `exp` claim";
  }
}

export class MalformedWebSocketTokenError extends Schema.TaggedErrorClass<MalformedWebSocketTokenError>()(
  "MalformedWebSocketTokenError",
  {
    reason: Schema.Literal("malformed_websocket_token"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Malformed websocket token.";
  }
}

export class InvalidWebSocketTokenSignatureError extends Schema.TaggedErrorClass<InvalidWebSocketTokenSignatureError>()(
  "InvalidWebSocketTokenSignatureError",
  {
    reason: Schema.Literal("invalid_websocket_token_signature"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Invalid websocket token signature.";
  }
}

export class InvalidWebSocketTokenPayloadError extends Schema.TaggedErrorClass<InvalidWebSocketTokenPayloadError>()(
  "InvalidWebSocketTokenPayloadError",
  {
    reason: Schema.Literal("invalid_websocket_token_payload"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Invalid websocket token payload.";
  }
}

export class WebSocketTokenExpiredError extends Schema.TaggedErrorClass<WebSocketTokenExpiredError>()(
  "WebSocketTokenExpiredError",
  {
    reason: Schema.Literal("websocket_token_expired"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Websocket token expired.";
  }
}

export class UnknownWebSocketSessionError extends Schema.TaggedErrorClass<UnknownWebSocketSessionError>()(
  "UnknownWebSocketSessionError",
  {
    reason: Schema.Literal("unknown_websocket_session"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Unknown websocket session.";
  }
}

export class WebSocketSessionExpiredError extends Schema.TaggedErrorClass<WebSocketSessionExpiredError>()(
  "WebSocketSessionExpiredError",
  {
    reason: Schema.Literal("websocket_session_expired"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Websocket session expired.";
  }
}

export class WebSocketSessionRevokedError extends Schema.TaggedErrorClass<WebSocketSessionRevokedError>()(
  "WebSocketSessionRevokedError",
  {
    reason: Schema.Literal("websocket_session_revoked"),
    ...sessionCredentialInvalidErrorContext,
  },
) {
  override get message(): string {
    return "Websocket session revoked.";
  }
}

export const SessionCredentialInvalidError = Schema.Union([
  MalformedSessionTokenError,
  InvalidSessionTokenSignatureError,
  InvalidSessionTokenPayloadError,
  SessionTokenExpiredError,
  UnknownSessionTokenError,
  SessionTokenRevokedError,
  InvalidSessionExpirationClaimError,
  MalformedWebSocketTokenError,
  InvalidWebSocketTokenSignatureError,
  InvalidWebSocketTokenPayloadError,
  WebSocketTokenExpiredError,
  UnknownWebSocketSessionError,
  WebSocketSessionExpiredError,
  WebSocketSessionRevokedError,
]);
export type SessionCredentialInvalidError = typeof SessionCredentialInvalidError.Type;
export const isSessionCredentialInvalidError = Schema.is(SessionCredentialInvalidError);

const sessionCredentialInternalErrorContext = {
  cause: Schema.Defect(),
};

export class SessionClaimsEncodingError extends Schema.TaggedErrorClass<SessionClaimsEncodingError>()(
  "SessionClaimsEncodingError",
  {
    operation: Schema.Literals(["encode_session_claims", "encode_websocket_claims"]),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to encode claims";
  }
}

export class SessionCredentialIssueError extends Schema.TaggedErrorClass<SessionCredentialIssueError>()(
  "SessionCredentialIssueError",
  {
    operation: Schema.Literal("issue_session_credential"),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue session credential.";
  }
}

export class SessionCredentialVerificationError extends Schema.TaggedErrorClass<SessionCredentialVerificationError>()(
  "SessionCredentialVerificationError",
  {
    operation: Schema.Literal("verify_session_credential"),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to verify session credential.";
  }
}

export class WebSocketTokenIssueError extends Schema.TaggedErrorClass<WebSocketTokenIssueError>()(
  "WebSocketTokenIssueError",
  {
    operation: Schema.Literal("issue_websocket_token"),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue websocket token.";
  }
}

export class WebSocketTokenVerificationError extends Schema.TaggedErrorClass<WebSocketTokenVerificationError>()(
  "WebSocketTokenVerificationError",
  {
    operation: Schema.Literal("verify_websocket_token"),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to verify websocket token.";
  }
}

export class ActiveSessionsListError extends Schema.TaggedErrorClass<ActiveSessionsListError>()(
  "ActiveSessionsListError",
  {
    operation: Schema.Literal("list_active_sessions"),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to list active sessions.";
  }
}

export class SessionRevocationError extends Schema.TaggedErrorClass<SessionRevocationError>()(
  "SessionRevocationError",
  {
    operation: Schema.Literal("revoke_session"),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke session.";
  }
}

export class OtherSessionsRevocationError extends Schema.TaggedErrorClass<OtherSessionsRevocationError>()(
  "OtherSessionsRevocationError",
  {
    operation: Schema.Literal("revoke_other_sessions"),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke other sessions.";
  }
}

export const SessionCredentialInternalError = Schema.Union([
  SessionClaimsEncodingError,
  SessionCredentialIssueError,
  SessionCredentialVerificationError,
  WebSocketTokenIssueError,
  WebSocketTokenVerificationError,
  ActiveSessionsListError,
  SessionRevocationError,
  OtherSessionsRevocationError,
]);
export type SessionCredentialInternalError = typeof SessionCredentialInternalError.Type;
export const isSessionCredentialInternalError = Schema.is(SessionCredentialInternalError);

export const SessionCredentialError = Schema.Union([
  SessionCredentialInvalidError,
  SessionCredentialInternalError,
]);
export type SessionCredentialError = typeof SessionCredentialError.Type;
export const isSessionCredentialError = Schema.is(SessionCredentialError);

export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly cookieName: string;
    readonly issue: (input?: {
      readonly ttl?: Duration.Duration;
      readonly subject?: string;
      readonly method?: ServerAuthSessionMethod;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly client?: AuthClientMetadata;
      readonly proofKeyThumbprint?: string;
    }) => Effect.Effect<IssuedSession, SessionCredentialInternalError>;
    readonly verify: (token: string) => Effect.Effect<VerifiedSession, SessionCredentialError>;
    readonly issueWebSocketToken: (
      sessionId: AuthSessionId,
      input?: {
        readonly ttl?: Duration.Duration;
      },
    ) => Effect.Effect<
      {
        readonly token: string;
        readonly expiresAt: DateTime.DateTime;
      },
      SessionCredentialInternalError
    >;
    readonly verifyWebSocketToken: (
      token: string,
    ) => Effect.Effect<VerifiedSession, SessionCredentialError>;
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<AuthClientSession>,
      SessionCredentialInternalError
    >;
    readonly streamChanges: Stream.Stream<SessionCredentialChange>;
    readonly revoke: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, SessionCredentialInternalError>;
    readonly revokeAllExcept: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<number, SessionCredentialInternalError>;
    readonly markConnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
    readonly markDisconnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
  }
>()("t3/auth/SessionStore") {}

const SIGNING_SECRET_NAME = "server-signing-key";
const DEFAULT_SESSION_TTL = Duration.days(30);
const DEFAULT_WEBSOCKET_TOKEN_TTL = Duration.minutes(5);

const SessionClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: Schema.Literals(["browser-session-cookie", "bearer-access-token", "dpop-access-token"]),
  jkt: Schema.optionalKey(Schema.String),
  iat: Schema.Number,
  exp: Schema.Number,
});
type SessionClaims = typeof SessionClaims.Type;

const WebSocketClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("websocket"),
  sid: AuthSessionId,
  iat: Schema.Number,
  exp: Schema.Number,
});
type WebSocketClaims = typeof WebSocketClaims.Type;

const decodeSessionClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionClaims));
const decodeWebSocketClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(WebSocketClaims));

function createDefaultClientMetadata(): AuthClientMetadata {
  return {
    deviceType: "unknown",
  };
}

function toClientMetadata(record: {
  readonly label: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceType: AuthClientMetadata["deviceType"];
  readonly os: string | null;
  readonly browser: string | null;
}): AuthClientMetadata {
  return {
    ...(record.label ? { label: record.label } : {}),
    ...(record.ipAddress ? { ipAddress: record.ipAddress } : {}),
    ...(record.userAgent ? { userAgent: record.userAgent } : {}),
    deviceType: record.deviceType,
    ...(record.os ? { os: record.os } : {}),
    ...(record.browser ? { browser: record.browser } : {}),
  };
}

function toAuthClientSession(input: Omit<AuthClientSession, "current">): AuthClientSession {
  return {
    ...input,
    current: false,
  };
}

const sessionCredentialInvalidError = (
  reason: SessionCredentialInvalidError["reason"],
  cause?: unknown,
): SessionCredentialInvalidError => {
  switch (reason) {
    case "malformed_session_token":
      return new MalformedSessionTokenError({ reason, cause });
    case "invalid_session_token_signature":
      return new InvalidSessionTokenSignatureError({ reason, cause });
    case "invalid_session_token_payload":
      return new InvalidSessionTokenPayloadError({ reason, cause });
    case "session_token_expired":
      return new SessionTokenExpiredError({ reason, cause });
    case "unknown_session_token":
      return new UnknownSessionTokenError({ reason, cause });
    case "session_token_revoked":
      return new SessionTokenRevokedError({ reason, cause });
    case "invalid_session_exp_claim":
      return new InvalidSessionExpirationClaimError({ reason, cause });
    case "malformed_websocket_token":
      return new MalformedWebSocketTokenError({ reason, cause });
    case "invalid_websocket_token_signature":
      return new InvalidWebSocketTokenSignatureError({ reason, cause });
    case "invalid_websocket_token_payload":
      return new InvalidWebSocketTokenPayloadError({ reason, cause });
    case "websocket_token_expired":
      return new WebSocketTokenExpiredError({ reason, cause });
    case "unknown_websocket_session":
      return new UnknownWebSocketSessionError({ reason, cause });
    case "websocket_session_expired":
      return new WebSocketSessionExpiredError({ reason, cause });
    case "websocket_session_revoked":
      return new WebSocketSessionRevokedError({ reason, cause });
  }
};

const sessionCredentialInternalError = (
  operation: SessionCredentialInternalError["operation"],
  cause: unknown,
): SessionCredentialInternalError => {
  switch (operation) {
    case "encode_session_claims":
    case "encode_websocket_claims":
      return new SessionClaimsEncodingError({ operation, cause });
    case "issue_session_credential":
      return new SessionCredentialIssueError({ operation, cause });
    case "verify_session_credential":
      return new SessionCredentialVerificationError({ operation, cause });
    case "issue_websocket_token":
      return new WebSocketTokenIssueError({ operation, cause });
    case "verify_websocket_token":
      return new WebSocketTokenVerificationError({ operation, cause });
    case "list_active_sessions":
      return new ActiveSessionsListError({ operation, cause });
    case "revoke_session":
      return new SessionRevocationError({ operation, cause });
    case "revoke_other_sessions":
      return new OtherSessionsRevocationError({ operation, cause });
  }
};

const toSessionCredentialInternalError =
  (operation: SessionCredentialInternalError["operation"]) => (cause: unknown) =>
    sessionCredentialInternalError(operation, cause);

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const authSessions = yield* AuthSessions.AuthSessionRepository;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
  const connectedSessionsRef = yield* Ref.make(new Map<string, number>());
  const changesPubSub = yield* PubSub.unbounded<SessionCredentialChange>();
  const cookieName = resolveSessionCookieName({
    mode: serverConfig.mode,
    port: serverConfig.port,
  });

  const emitUpsert = (clientSession: AuthClientSession) =>
    PubSub.publish(changesPubSub, {
      type: "clientUpserted",
      clientSession,
    }).pipe(Effect.asVoid);

  const emitRemoved = (sessionId: AuthSessionId) =>
    PubSub.publish(changesPubSub, {
      type: "clientRemoved",
      sessionId,
    }).pipe(Effect.asVoid);

  const loadActiveSession = (sessionId: AuthSessionId) =>
    Effect.gen(function* () {
      const row = yield* authSessions.getById({ sessionId });
      if (Option.isNone(row) || row.value.revokedAt !== null) {
        return Option.none<AuthClientSession>();
      }

      const connectedSessions = yield* Ref.get(connectedSessionsRef);
      return Option.some(
        toAuthClientSession({
          sessionId: row.value.sessionId,
          subject: row.value.subject,
          scopes: row.value.scopes,
          method: row.value.method,
          client: toClientMetadata(row.value.client),
          issuedAt: row.value.issuedAt,
          expiresAt: row.value.expiresAt,
          lastConnectedAt: row.value.lastConnectedAt,
          connected: connectedSessions.has(row.value.sessionId),
        }),
      );
    });

  const markConnected: SessionStore["Service"]["markConnected"] = (sessionId) =>
    Ref.modify(connectedSessionsRef, (current) => {
      const next = new Map(current);
      const wasDisconnected = !next.has(sessionId);
      next.set(sessionId, (next.get(sessionId) ?? 0) + 1);
      return [wasDisconnected, next] as const;
    }).pipe(
      Effect.flatMap((wasDisconnected) =>
        wasDisconnected
          ? DateTime.now.pipe(
              Effect.flatMap((lastConnectedAt) =>
                authSessions.setLastConnectedAt({
                  sessionId,
                  lastConnectedAt,
                }),
              ),
            )
          : Effect.void,
      ),
      Effect.flatMap(() => loadActiveSession(sessionId)),
      Effect.flatMap((session) =>
        Option.isSome(session) ? emitUpsert(session.value) : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish connected-session auth update.").pipe(
          Effect.annotateLogs({
            sessionId,
            cause,
          }),
        ),
      ),
      Effect.withSpan("SessionStore.markConnected"),
    );

  const markDisconnected: SessionStore["Service"]["markDisconnected"] = (sessionId) =>
    Ref.update(connectedSessionsRef, (current) => {
      const next = new Map(current);
      const remaining = (next.get(sessionId) ?? 0) - 1;
      if (remaining > 0) {
        next.set(sessionId, remaining);
      } else {
        next.delete(sessionId);
      }
      return next;
    }).pipe(
      Effect.flatMap(() => loadActiveSession(sessionId)),
      Effect.flatMap((session) =>
        Option.isSome(session) ? emitUpsert(session.value) : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish disconnected-session auth update.").pipe(
          Effect.annotateLogs({
            sessionId,
            cause,
          }),
        ),
      ),
      Effect.withSpan("SessionStore.markDisconnected"),
    );

  const encodeClaims = Schema.encodeEffect(Schema.fromJsonString(SessionClaims));
  const issue: SessionStore["Service"]["issue"] = Effect.fn("SessionStore.issue")(
    function* (input) {
      const sessionId = AuthSessionId.make(yield* crypto.randomUUIDv4);
      const issuedAt = yield* DateTime.now;
      const expiresAt = DateTime.add(issuedAt, {
        milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_SESSION_TTL),
      });
      const claims: SessionClaims = {
        v: 1,
        kind: "session",
        sid: sessionId,
        sub: input?.subject ?? "browser",
        scopes: input?.scopes ?? AuthStandardClientScopes,
        method: input?.method ?? "browser-session-cookie",
        ...(input?.proofKeyThumbprint ? { jkt: input.proofKeyThumbprint } : {}),
        iat: issuedAt.epochMilliseconds,
        exp: expiresAt.epochMilliseconds,
      };

      const encodedPayload = yield* encodeClaims(claims).pipe(
        Effect.map(base64UrlEncode),
        Effect.mapError((cause) => sessionCredentialInternalError("encode_session_claims", cause)),
      );
      const signature = signPayload(encodedPayload, signingSecret);
      const client = input?.client ?? createDefaultClientMetadata();
      yield* authSessions.create({
        sessionId,
        subject: claims.sub,
        scopes: claims.scopes,
        method: claims.method,
        client: {
          label: client.label ?? null,
          ipAddress: client.ipAddress ?? null,
          userAgent: client.userAgent ?? null,
          deviceType: client.deviceType,
          os: client.os ?? null,
          browser: client.browser ?? null,
        },
        issuedAt,
        expiresAt,
      });
      yield* emitUpsert(
        toAuthClientSession({
          sessionId,
          subject: claims.sub,
          scopes: claims.scopes,
          method: claims.method,
          client,
          issuedAt,
          expiresAt,
          lastConnectedAt: null,
          connected: false,
        }),
      );

      return {
        sessionId,
        token: `${encodedPayload}.${signature}`,
        method: claims.method,
        client,
        expiresAt: expiresAt,
        scopes: claims.scopes,
        ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
      } satisfies IssuedSession;
    },
    Effect.mapError(toSessionCredentialInternalError("issue_session_credential")),
  );

  const verify: SessionStore["Service"]["verify"] = Effect.fn("SessionStore.verify")(
    function* (token) {
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature) {
        return yield* sessionCredentialInvalidError("malformed_session_token");
      }

      const expectedSignature = signPayload(encodedPayload, signingSecret);
      if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
        return yield* sessionCredentialInvalidError("invalid_session_token_signature");
      }

      const claims = yield* decodeSessionClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError((cause) =>
          sessionCredentialInvalidError("invalid_session_token_payload", cause),
        ),
      );

      const now = yield* Clock.currentTimeMillis;
      if (claims.exp <= now) {
        return yield* sessionCredentialInvalidError("session_token_expired");
      }

      const row = yield* authSessions.getById({ sessionId: claims.sid });
      if (Option.isNone(row)) {
        return yield* sessionCredentialInvalidError("unknown_session_token");
      }
      if (row.value.revokedAt !== null) {
        return yield* sessionCredentialInvalidError("session_token_revoked");
      }

      const expiresAt = DateTime.make(claims.exp);
      if (Option.isNone(expiresAt)) {
        return yield* sessionCredentialInvalidError("invalid_session_exp_claim");
      }

      return {
        sessionId: claims.sid,
        token,
        method: claims.method,
        client: toClientMetadata(row.value.client),
        expiresAt: expiresAt.value,
        subject: claims.sub,
        scopes: claims.scopes,
        ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
      } satisfies VerifiedSession;
    },
    Effect.mapError((cause) =>
      isSessionCredentialInvalidError(cause)
        ? cause
        : sessionCredentialInternalError("verify_session_credential", cause),
    ),
  );

  const encodeWsClaims = Schema.encodeEffect(Schema.fromJsonString(WebSocketClaims));
  const issueWebSocketToken: SessionStore["Service"]["issueWebSocketToken"] = Effect.fn(
    "SessionStore.issueWebSocketToken",
  )(
    function* (sessionId, input) {
      const issuedAt = yield* DateTime.now;
      const expiresAt = DateTime.add(issuedAt, {
        milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_WEBSOCKET_TOKEN_TTL),
      });
      const claims: WebSocketClaims = {
        v: 1,
        kind: "websocket",
        sid: sessionId,
        iat: issuedAt.epochMilliseconds,
        exp: expiresAt.epochMilliseconds,
      };
      const encodedPayload = yield* encodeWsClaims(claims).pipe(
        Effect.map(base64UrlEncode),
        Effect.mapError((cause) =>
          sessionCredentialInternalError("encode_websocket_claims", cause),
        ),
      );
      const signature = signPayload(encodedPayload, signingSecret);
      return {
        token: `${encodedPayload}.${signature}`,
        expiresAt,
      };
    },
    Effect.mapError(toSessionCredentialInternalError("issue_websocket_token")),
  );

  const verifyWebSocketToken: SessionStore["Service"]["verifyWebSocketToken"] = Effect.fn(
    "SessionStore.verifyWebSocketToken",
  )(
    function* (token) {
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature) {
        return yield* sessionCredentialInvalidError("malformed_websocket_token");
      }

      const expectedSignature = signPayload(encodedPayload, signingSecret);
      if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
        return yield* sessionCredentialInvalidError("invalid_websocket_token_signature");
      }

      const claims = yield* decodeWebSocketClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError((cause) =>
          sessionCredentialInvalidError("invalid_websocket_token_payload", cause),
        ),
      );

      const now = yield* Clock.currentTimeMillis;
      if (claims.exp <= now) {
        return yield* sessionCredentialInvalidError("websocket_token_expired");
      }

      const row = yield* authSessions.getById({ sessionId: claims.sid });
      if (Option.isNone(row)) {
        return yield* sessionCredentialInvalidError("unknown_websocket_session");
      }
      if (row.value.expiresAt.epochMilliseconds <= now) {
        return yield* sessionCredentialInvalidError("websocket_session_expired");
      }
      if (row.value.revokedAt !== null) {
        return yield* sessionCredentialInvalidError("websocket_session_revoked");
      }

      return {
        sessionId: row.value.sessionId,
        token,
        method: row.value.method,
        client: toClientMetadata(row.value.client),
        expiresAt: row.value.expiresAt,
        subject: row.value.subject,
        scopes: row.value.scopes,
      } satisfies VerifiedSession;
    },
    Effect.mapError((cause) =>
      isSessionCredentialInvalidError(cause)
        ? cause
        : sessionCredentialInternalError("verify_websocket_token", cause),
    ),
  );

  const listActive: SessionStore["Service"]["listActive"] = Effect.fn("SessionStore.listActive")(
    function* () {
      const now = yield* DateTime.now;
      const connectedSessions = yield* Ref.get(connectedSessionsRef);
      const rows = yield* authSessions.listActive({ now });

      return rows.map((row) =>
        toAuthClientSession({
          sessionId: row.sessionId,
          subject: row.subject,
          scopes: row.scopes,
          method: row.method,
          client: toClientMetadata(row.client),
          issuedAt: row.issuedAt,
          expiresAt: row.expiresAt,
          lastConnectedAt: row.lastConnectedAt,
          connected: connectedSessions.has(row.sessionId),
        }),
      );
    },
    Effect.mapError(toSessionCredentialInternalError("list_active_sessions")),
  );

  const revoke: SessionStore["Service"]["revoke"] = Effect.fn("SessionStore.revoke")(
    function* (sessionId) {
      const revokedAt = yield* DateTime.now;
      const revoked = yield* authSessions.revoke({
        sessionId,
        revokedAt,
      });
      if (revoked) {
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        });
        yield* emitRemoved(sessionId);
      }
      return revoked;
    },
    Effect.mapError(toSessionCredentialInternalError("revoke_session")),
  );

  const revokeAllExcept: SessionStore["Service"]["revokeAllExcept"] = Effect.fn(
    "SessionStore.revokeAllExcept",
  )(
    function* (sessionId) {
      const revokedAt = yield* DateTime.now;
      const revokedSessionIds = yield* authSessions.revokeAllExcept({
        currentSessionId: sessionId,
        revokedAt,
      });
      if (revokedSessionIds.length > 0) {
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          for (const revokedSessionId of revokedSessionIds) {
            next.delete(revokedSessionId);
          }
          return next;
        });
        yield* Effect.forEach(
          revokedSessionIds,
          (revokedSessionId) => emitRemoved(revokedSessionId),
          {
            concurrency: "unbounded",
            discard: true,
          },
        );
      }
      return revokedSessionIds.length;
    },
    Effect.mapError(toSessionCredentialInternalError("revoke_other_sessions")),
  );

  return SessionStore.of({
    cookieName,
    issue,
    verify,
    issueWebSocketToken,
    verifyWebSocketToken,
    listActive,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke,
    revokeAllExcept,
    markConnected,
    markDisconnected,
  });
});

export const layer = Layer.effect(SessionStore, make).pipe(Layer.provideMerge(AuthSessions.layer));
