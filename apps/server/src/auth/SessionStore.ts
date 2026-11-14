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
import {
  DEFAULT_SESSION_TTL,
  DEFAULT_WEBSOCKET_TOKEN_TTL,
  SIGNING_SECRET_NAME,
  createDefaultClientMetadata,
  decodeSessionClaims,
  decodeWebSocketClaims,
  toAuthClientSession,
  SessionClaims,
  WebSocketClaims,
} from "./SessionStoreClaims.ts";


export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly cookieName: string;
    readonly legacyCookieName: string | undefined;
    readonly issue: (input?: {
      readonly ttl?: Duration.Duration;
      readonly subject?: string;
      readonly method?: ServerAuthSessionMethod;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly client?: AuthClientMetadata;
      readonly proofKeyThumbprint?: string;
      readonly runtimeModeCeiling?: RuntimeMode;
      readonly peerLink?: boolean;
      readonly replaceActiveForSubjectAndMethod?: boolean;
      readonly replaceSessionId?: AuthSessionId;
    }) => Effect.Effect<IssuedSession, SessionCredentialInternalError>;
    readonly verify: (token: string) => Effect.Effect<VerifiedSession, SessionCredentialError>;
    readonly issueWebSocketToken: (
      sessionId: AuthSessionId,
      input?: {
        readonly ttl?: Duration.Duration;
        readonly audience?: AuthWebSocketTicketUse;
        readonly proofKeyThumbprint?: string;
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
    ) => Effect.Effect<VerifiedWebSocketTicket, SessionCredentialError>;
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<AuthClientSession>,
      SessionCredentialInternalError
    >;
    readonly streamChanges: Stream.Stream<SessionCredentialChange>;
    /** Completes when a live socket's session is revoked or expires without a renewal for its DPoP key. */
    readonly awaitInvalidation: (
      sessionId: AuthSessionId,
      proofKeyThumbprint?: string,
    ) => Effect.Effect<void, SessionCredentialVerificationError>;
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

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const authSessions = yield* AuthSessions.AuthSessionRepository;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
  const connectedSessionsRef = yield* Ref.make(new Map<AuthSessionId, number>());
  const changesPubSub = yield* PubSub.unbounded<SessionCredentialChange>();
  // Newest session per DPoP key. A live socket moves to it at expiry, so a
  // client that renews its short-lived token keeps its socket.
  const latestSessionByProofKey = new Map<string, AuthSessionId>();
  const cookieInput = {
    mode: serverConfig.mode,
    port: serverConfig.port,
    host: serverConfig.host,
    instanceKey: serverConfig.stateDir,
    environmentId: yield* serverEnvironment.getEnvironmentId,
    development: serverConfig.devUrl !== undefined,
  } as const;
  const cookieName = resolveSessionCookieName(cookieInput);
  const legacyCookieName = resolveLegacySessionCookieName(cookieInput);
  const devAuth = resolveReusableDevAuth(serverConfig);
  if (devAuth) {
    yield* authSessions
      .createIfAbsent({
        sessionId: devAuth.sessionId,
        subject: "reusable-dev-token",
        scopes: AuthStandardClientScopes,
        method: "browser-session-cookie",
        client: {
          label: "Reusable dev token",
          ipAddress: null,
          userAgent: null,
          deviceType: "unknown",
          os: null,
          browser: null,
        },
        issuedAt: yield* DateTime.now,
        expiresAt: REUSABLE_DEV_SESSION_EXPIRES_AT,
      })
      .pipe(
        Effect.mapError(
          (cause) => new SessionCredentialIssueError({ sessionId: devAuth.sessionId, cause }),
        ),
      );
  }

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

  const loadActiveSession = Effect.fn("SessionStore.loadActiveSession")(function* (
    sessionId: AuthSessionId,
  ) {
    const row = yield* authSessions.getById({ sessionId });
    if (Option.isNone(row) || row.value.revokedAt !== null) {
      return Option.none<AuthClientSession>();
    }

    const connectedSessions = yield* Ref.get(connectedSessionsRef);
    const connected = connectedSessions.has(row.value.sessionId);
    const now = yield* DateTime.now;
    if (!connected && row.value.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
      return Option.none<AuthClientSession>();
    }
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
        connected,
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
        Option.isSome(session) ? emitUpsert(session.value) : emitRemoved(sessionId),
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
      const sessionId = AuthSessionId.make(
        yield* random
          .uuidV4()
          .pipe(Effect.mapError((cause) => new SessionCredentialIssueError({ cause }))),
      );
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
        ...(input?.runtimeModeCeiling ? { rtc: input.runtimeModeCeiling } : {}),
        ...(input?.peerLink === true ? { plk: 1 as const } : {}),
        iat: issuedAt.epochMilliseconds,
        exp: expiresAt.epochMilliseconds,
      };

      const encodedPayload = yield* encodeClaims(claims).pipe(
        Effect.map(base64UrlEncode),
        Effect.mapError(
          (cause) =>
            new SessionCredentialIssueError({
              sessionId,
              cause: new SessionClaimsEncodingError({
                sessionId,
                operation: "encode_session_claims",
                cause,
              }),
            }),
        ),
      );
      const signature = signPayload(encodedPayload, signingSecret);
      const client = input?.client ?? createDefaultClientMetadata();
      const sessionRecord = {
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
      } satisfies AuthSessions.CreateAuthSessionInput;
      const replacedSessionIds = yield* (
        input?.replaceSessionId !== undefined || input?.replaceActiveForSubjectAndMethod
          ? authSessions.createReplacingActive({
              session: sessionRecord,
              revokedAt: issuedAt,
              ...(input.replaceSessionId !== undefined
                ? { replaceSessionId: input.replaceSessionId }
                : {}),
            })
          : authSessions.create(sessionRecord).pipe(Effect.as([] as ReadonlyArray<AuthSessionId>))
      ).pipe(Effect.mapError((cause) => new SessionCredentialIssueError({ sessionId, cause })));
      if (claims.jkt) latestSessionByProofKey.set(claims.jkt, sessionId);
      if (replacedSessionIds.length > 0) {
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          for (const replacedSessionId of replacedSessionIds) {
            next.delete(replacedSessionId);
          }
          return next;
        });
        yield* Effect.forEach(replacedSessionIds, emitRemoved, {
          concurrency: "unbounded",
          discard: true,
        });
      }
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
  );

  const verify: SessionStore["Service"]["verify"] = Effect.fn("SessionStore.verify")(
    function* (token) {
      if (devAuth?.matches(token)) {
        const row = yield* authSessions
          .getById({ sessionId: devAuth.sessionId })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SessionCredentialVerificationError({ sessionId: devAuth.sessionId, cause }),
            ),
          );
        if (Option.isNone(row)) {
          return yield* new UnknownSessionTokenError({ sessionId: devAuth.sessionId });
        }
        if (row.value.revokedAt !== null) {
          return yield* new SessionTokenRevokedError({
            sessionId: devAuth.sessionId,
            revokedAt: row.value.revokedAt,
          });
        }
        const observedAt = yield* DateTime.now;
        if (row.value.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds) {
          return yield* new SessionTokenExpiredError({
            sessionId: devAuth.sessionId,
            expiresAt: row.value.expiresAt,
            observedAt,
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
      }
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature) {
        return yield* new MalformedSessionTokenError({});
      }

      const expectedSignature = signPayload(encodedPayload, signingSecret);
      if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
        return yield* new InvalidSessionTokenSignatureError({});
      }

      const claims = yield* decodeSessionClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError((cause) => new InvalidSessionTokenPayloadError({ cause })),
      );

      const observedAt = yield* DateTime.now;
      const expiresAt = DateTime.make(claims.exp);
      if (Option.isNone(expiresAt)) {
        return yield* new InvalidSessionExpirationClaimError({
          sessionId: claims.sid,
          expirationClaim: claims.exp,
        });
      }
      if (claims.exp <= observedAt.epochMilliseconds) {
        return yield* new SessionTokenExpiredError({
          sessionId: claims.sid,
          expiresAt: expiresAt.value,
          observedAt,
        });
      }

      const row = yield* authSessions
        .getById({ sessionId: claims.sid })
        .pipe(
          Effect.mapError(
            (cause) => new SessionCredentialVerificationError({ sessionId: claims.sid, cause }),
          ),
        );
      if (Option.isNone(row)) {
        return yield* new UnknownSessionTokenError({ sessionId: claims.sid });
      }
      if (row.value.revokedAt !== null) {
        return yield* new SessionTokenRevokedError({
          sessionId: claims.sid,
          revokedAt: row.value.revokedAt,
        });
      }

      return {
        sessionId: claims.sid,
        token,
        method: claims.method,
        client: toClientMetadata(row.value.client),
        expiresAt: expiresAt.value,
        subject: claims.sub,
        scopes: row.value.scopes,
        ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
        ...(claims.rtc ? { runtimeModeCeiling: claims.rtc } : {}),
        ...(claims.plk === 1 ? { peerLink: true as const } : {}),
      } satisfies VerifiedSession;
    },
  );

  const encodeWsClaims = Schema.encodeEffect(Schema.fromJsonString(WebSocketClaims));
  const issueWebSocketToken: SessionStore["Service"]["issueWebSocketToken"] = Effect.fn(
    "SessionStore.issueWebSocketToken",
  )(function* (sessionId, input) {
    const issuedAt = yield* DateTime.now;
    const expiresAt = DateTime.add(issuedAt, {
      milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_WEBSOCKET_TOKEN_TTL),
    });
    const claims: WebSocketClaims = {
      v: 1,
      kind: "websocket",
      sid: sessionId,
      ...(input?.audience ? { aud: input.audience } : {}),
      ...(input?.proofKeyThumbprint ? { jkt: input.proofKeyThumbprint } : {}),
      iat: issuedAt.epochMilliseconds,
      exp: expiresAt.epochMilliseconds,
    };
    const encodedPayload = yield* encodeWsClaims(claims).pipe(
      Effect.map(base64UrlEncode),
      Effect.mapError(
        (cause) =>
          new WebSocketTokenIssueError({
            sessionId,
            cause: new SessionClaimsEncodingError({
              sessionId,
              operation: "encode_websocket_claims",
              cause,
            }),
          }),
      ),
    );
    const signature = signPayload(encodedPayload, signingSecret);
    return {
      token: `${encodedPayload}.${signature}`,
      expiresAt,
    };
  });

  const verifyWebSocketToken: SessionStore["Service"]["verifyWebSocketToken"] = Effect.fn(
    "SessionStore.verifyWebSocketToken",
  )(function* (token) {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
      return yield* new MalformedWebSocketTokenError({});
    }

    const expectedSignature = signPayload(encodedPayload, signingSecret);
    if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
      return yield* new InvalidWebSocketTokenSignatureError({});
    }

    const claims = yield* decodeWebSocketClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
      Effect.mapError((cause) => new InvalidWebSocketTokenPayloadError({ cause })),
    );
    if (claims.sid.startsWith(REUSABLE_DEV_SESSION_PREFIX) && claims.sid !== devAuth?.sessionId) {
      return yield* new UnknownWebSocketSessionError({ sessionId: claims.sid });
    }

    const observedAt = yield* DateTime.now;
    const expiresAt = DateTime.make(claims.exp);
    if (Option.isNone(expiresAt)) {
      return yield* new InvalidSessionExpirationClaimError({
        sessionId: claims.sid,
        expirationClaim: claims.exp,
      });
    }
    if (claims.exp <= observedAt.epochMilliseconds) {
      return yield* new WebSocketTokenExpiredError({
        sessionId: claims.sid,
        expiresAt: expiresAt.value,
        observedAt,
      });
    }

    const row = yield* authSessions
      .getById({ sessionId: claims.sid })
      .pipe(
        Effect.mapError(
          (cause) => new WebSocketTokenVerificationError({ sessionId: claims.sid, cause }),
        ),
      );
    if (Option.isNone(row)) {
      return yield* new UnknownWebSocketSessionError({ sessionId: claims.sid });
    }
    if (row.value.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds) {
      return yield* new WebSocketSessionExpiredError({
        sessionId: claims.sid,
        expiresAt: row.value.expiresAt,
        observedAt,
      });
    }
    if (row.value.revokedAt !== null) {
      return yield* new WebSocketSessionRevokedError({
        sessionId: claims.sid,
        revokedAt: row.value.revokedAt,
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
      ...(claims.aud ? { audience: claims.aud } : {}),
      ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
    } satisfies VerifiedWebSocketTicket;
  });

  const listActive: SessionStore["Service"]["listActive"] = Effect.fn("SessionStore.listActive")(
    function* () {
      const now = yield* DateTime.now;
      const connectedSessions = yield* Ref.get(connectedSessionsRef);
      const rows = yield* authSessions.listActive({
        now,
        connectedSessionIds: Array.from(connectedSessions.keys()),
      });

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
    Effect.mapError((cause) => new ActiveSessionsListError({ cause })),
  );

  const revoke: SessionStore["Service"]["revoke"] = Effect.fn("SessionStore.revoke")(
    function* (sessionId) {
      const revokedAt = yield* DateTime.now;
      const revoked = yield* authSessions
        .revoke({
          sessionId,
          revokedAt,
        })
        .pipe(Effect.mapError((cause) => new SessionRevocationError({ sessionId, cause })));
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
  );

  const revokeAllExcept: SessionStore["Service"]["revokeAllExcept"] = Effect.fn(
    "SessionStore.revokeAllExcept",
  )(function* (sessionId) {
    const revokedAt = yield* DateTime.now;
    const revokedSessionIds = yield* authSessions
      .revokeAllExcept({
        currentSessionId: sessionId,
        revokedAt,
      })
      .pipe(
        Effect.mapError(
          (cause) => new OtherSessionsRevocationError({ currentSessionId: sessionId, cause }),
        ),
      );
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
  });

  const awaitInvalidation = Effect.fn(function* (
    sessionId: AuthSessionId,
    proofKeyThumbprint?: string,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before reading: revocation can race with the WebSocket upgrade.
        const subscription = yield* PubSub.subscribe(changesPubSub);
        const readRow = (id: AuthSessionId) =>
          authSessions
            .getById({ sessionId: id })
            .pipe(
              Effect.mapError(
                (cause) => new SessionCredentialVerificationError({ sessionId: id, cause }),
              ),
            );
        const original = yield* readRow(sessionId);
        if (Option.isNone(original)) return;
        // Revoking any session the socket has used closes it. Events only wake this loop
        // and the rows decide: revocations are written before they are published, and
        // clientRemoved also reports an expired session losing its last socket.
        const chain = [sessionId];
        const nextRemoval = Effect.gen(function* () {
          while (true) {
            const change = yield* PubSub.take(subscription);
            if (change.type === "clientRemoved" && chain.includes(change.sessionId)) return;
          }
        });
        let current = original.value;
        while (true) {
          const rows = yield* Effect.forEach(chain, readRow);
          if (rows.some((row) => Option.isNone(row) || row.value.revokedAt !== null)) return;
          const now = yield* DateTime.now;
          const remaining = current.expiresAt.epochMilliseconds - now.epochMilliseconds;
          if (remaining > 0) {
            yield* Effect.raceFirst(nextRemoval, Effect.sleep(Duration.millis(remaining)));
            continue;
          }
          const successorId =
            proofKeyThumbprint === undefined
              ? undefined
              : latestSessionByProofKey.get(proofKeyThumbprint);
          if (successorId === undefined || successorId === current.sessionId) return;
          const successor = yield* readRow(successorId);
          // The socket keeps its original scopes, so the renewal must still grant all of them.
          if (
            Option.isNone(successor) ||
            successor.value.subject !== original.value.subject ||
            !original.value.scopes.every((scope) => successor.value.scopes.includes(scope))
          ) {
            return;
          }
          chain.push(successorId);
          current = successor.value;
        }
      }),
    );
  });

  return SessionStore.of({
    cookieName,
    legacyCookieName,
    issue,
    verify,
    issueWebSocketToken,
    verifyWebSocketToken,
    listActive,
    awaitInvalidation,
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
export * from "./SessionStoreErrors.ts";
