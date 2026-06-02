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
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { AuthSessionRepositoryLive } from "../persistence/Layers/AuthSessions.ts";
import { AuthSessionRepository } from "../persistence/Services/AuthSessions.ts";
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
}

export interface VerifiedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt?: DateTime.DateTime;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
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

export class SessionCredentialInvalidError extends Data.TaggedError(
  "SessionCredentialInvalidError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SessionCredentialInternalError extends Data.TaggedError(
  "SessionCredentialInternalError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SessionCredentialError = SessionCredentialInvalidError | SessionCredentialInternalError;

export interface SessionStoreShape {
  readonly cookieName: string;
  readonly issue: (input?: {
    readonly ttl?: Duration.Duration;
    readonly subject?: string;
    readonly method?: ServerAuthSessionMethod;
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly client?: AuthClientMetadata;
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

export class SessionStore extends Context.Service<SessionStore, SessionStoreShape>()(
  "t3/auth/SessionStore",
) {}

const SIGNING_SECRET_NAME = "server-signing-key";
const DEFAULT_SESSION_TTL = Duration.days(30);
const DEFAULT_WEBSOCKET_TOKEN_TTL = Duration.minutes(5);

const SessionClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: Schema.Literals(["browser-session-cookie", "bearer-access-token"]),
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

const toSessionCredentialInternalError = (message: string) => (cause: unknown) =>
  new SessionCredentialInternalError({
    message,
    cause,
  });

export const make = Effect.fn("makeSessionStore")(function* () {
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const authSessions = yield* AuthSessionRepository;
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

  const markConnected: SessionStoreShape["markConnected"] = (sessionId) =>
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

  const markDisconnected: SessionStoreShape["markDisconnected"] = (sessionId) =>
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
  const issue: SessionStoreShape["issue"] = Effect.fn("SessionStore.issue")(
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
        iat: issuedAt.epochMilliseconds,
        exp: expiresAt.epochMilliseconds,
      };

      const encodedPayload = yield* encodeClaims(claims).pipe(
        Effect.map(base64UrlEncode),
        Effect.mapError(
          (cause) =>
            new SessionCredentialInternalError({ message: "Failed to encode claims", cause }),
        ),
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
      } satisfies IssuedSession;
    },
    Effect.mapError(toSessionCredentialInternalError("Failed to issue session credential.")),
  );

  const verify: SessionStoreShape["verify"] = Effect.fn("SessionStore.verify")(
    function* (token) {
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature) {
        return yield* new SessionCredentialInvalidError({
          message: "Malformed session token.",
        });
      }

      const expectedSignature = signPayload(encodedPayload, signingSecret);
      if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
        return yield* new SessionCredentialInvalidError({
          message: "Invalid session token signature.",
        });
      }

      const claims = yield* decodeSessionClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError(
          (cause) =>
            new SessionCredentialInvalidError({
              message: "Invalid session token payload.",
              cause,
            }),
        ),
      );

      const now = yield* Clock.currentTimeMillis;
      if (claims.exp <= now) {
        return yield* new SessionCredentialInvalidError({
          message: "Session token expired.",
        });
      }

      const row = yield* authSessions.getById({ sessionId: claims.sid });
      if (Option.isNone(row)) {
        return yield* new SessionCredentialInvalidError({
          message: "Unknown session token.",
        });
      }
      if (row.value.revokedAt !== null) {
        return yield* new SessionCredentialInvalidError({
          message: "Session token revoked.",
        });
      }

      const expiresAt = DateTime.make(claims.exp);
      if (Option.isNone(expiresAt)) {
        return yield* new SessionCredentialInvalidError({
          message: "Invalid `exp` claim",
        });
      }

      return {
        sessionId: claims.sid,
        token,
        method: claims.method,
        client: toClientMetadata(row.value.client),
        expiresAt: expiresAt.value,
        subject: claims.sub,
        scopes: claims.scopes,
      } satisfies VerifiedSession;
    },
    Effect.mapError((cause) =>
      cause._tag === "SessionCredentialInvalidError"
        ? cause
        : new SessionCredentialInternalError({
            message: "Failed to verify session credential.",
            cause,
          }),
    ),
  );

  const encodeWsClaims = Schema.encodeEffect(Schema.fromJsonString(WebSocketClaims));
  const issueWebSocketToken: SessionStoreShape["issueWebSocketToken"] = Effect.fn(
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
        Effect.mapError(
          (cause) =>
            new SessionCredentialInternalError({ message: "Failed to encode claims", cause }),
        ),
      );
      const signature = signPayload(encodedPayload, signingSecret);
      return {
        token: `${encodedPayload}.${signature}`,
        expiresAt,
      };
    },
    Effect.mapError(toSessionCredentialInternalError("Failed to issue websocket token.")),
  );

  const verifyWebSocketToken: SessionStoreShape["verifyWebSocketToken"] = Effect.fn(
    "SessionStore.verifyWebSocketToken",
  )(
    function* (token) {
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature) {
        return yield* new SessionCredentialInvalidError({
          message: "Malformed websocket token.",
        });
      }

      const expectedSignature = signPayload(encodedPayload, signingSecret);
      if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
        return yield* new SessionCredentialInvalidError({
          message: "Invalid websocket token signature.",
        });
      }

      const claims = yield* decodeWebSocketClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError(
          (cause) =>
            new SessionCredentialInvalidError({
              message: "Invalid websocket token payload.",
              cause,
            }),
        ),
      );

      const now = yield* Clock.currentTimeMillis;
      if (claims.exp <= now) {
        return yield* new SessionCredentialInvalidError({
          message: "Websocket token expired.",
        });
      }

      const row = yield* authSessions.getById({ sessionId: claims.sid });
      if (Option.isNone(row)) {
        return yield* new SessionCredentialInvalidError({
          message: "Unknown websocket session.",
        });
      }
      if (row.value.expiresAt.epochMilliseconds <= now) {
        return yield* new SessionCredentialInvalidError({
          message: "Websocket session expired.",
        });
      }
      if (row.value.revokedAt !== null) {
        return yield* new SessionCredentialInvalidError({
          message: "Websocket session revoked.",
        });
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
      cause._tag === "SessionCredentialInvalidError"
        ? cause
        : new SessionCredentialInternalError({
            message: "Failed to verify websocket token.",
            cause,
          }),
    ),
  );

  const listActive: SessionStoreShape["listActive"] = Effect.fn("SessionStore.listActive")(
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
    Effect.mapError(toSessionCredentialInternalError("Failed to list active sessions.")),
  );

  const revoke: SessionStoreShape["revoke"] = Effect.fn("SessionStore.revoke")(
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
    Effect.mapError(toSessionCredentialInternalError("Failed to revoke session.")),
  );

  const revokeAllExcept: SessionStoreShape["revokeAllExcept"] = Effect.fn(
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
    Effect.mapError(toSessionCredentialInternalError("Failed to revoke other sessions.")),
  );

  return {
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
  } satisfies SessionStoreShape;
});

export const layer = Layer.effect(SessionStore, make()).pipe(
  Layer.provideMerge(AuthSessionRepositoryLive),
);
