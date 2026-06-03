import {
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  type AuthAccessTokenResult,
  type AuthBrowserSessionResult,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthCreatePairingCredentialInput,
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type AuthPairingCredentialResult,
  type AuthSessionId,
  type AuthSessionState,
  type ServerAuthDescriptor,
  type ServerAuthSessionMethod,
  type AuthWebSocketTicketResult,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { layerConfig as SqlitePersistenceLayer } from "../persistence/Layers/Sqlite.ts";

export const DEFAULT_SESSION_SUBJECT = "cli-issued-session";
export const INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT = "administrative-bootstrap";

export interface IssuedPairingLink {
  readonly id: string;
  readonly credential: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export interface IssuedBearerSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: "bearer-access-token";
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.Utc;
}

export interface AuthenticatedSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly expiresAt?: DateTime.DateTime;
}

export class ServerAuthInternalError extends Data.TaggedError("ServerAuthInternalError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ServerAuthInvalidCredentialError extends Data.TaggedError(
  "ServerAuthInvalidCredentialError",
)<{
  readonly reason: "missing_credential" | "invalid_credential";
  readonly cause?: unknown;
}> {}

export class ServerAuthInvalidRequestError extends Data.TaggedError(
  "ServerAuthInvalidRequestError",
)<{
  readonly reason: "invalid_scope" | "scope_not_granted";
}> {}

export class ServerAuthForbiddenOperationError extends Data.TaggedError(
  "ServerAuthForbiddenOperationError",
)<{
  readonly reason: "current_session_revoke_not_allowed";
}> {}

export interface EnvironmentAuthShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
  readonly getSessionState: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthSessionState, ServerAuthInternalError>;
  readonly createBrowserSession: (
    credential: string,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<
    {
      readonly response: AuthBrowserSessionResult;
      readonly sessionToken: string;
    },
    ServerAuthInvalidCredentialError | ServerAuthInternalError
  >;
  readonly exchangeBootstrapCredentialForAccessToken: (
    credential: string,
    requestedScopes: ReadonlyArray<AuthEnvironmentScope> | undefined,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<
    AuthAccessTokenResult,
    ServerAuthInvalidCredentialError | ServerAuthInvalidRequestError | ServerAuthInternalError
  >;
  readonly createPairingLink: (input?: {
    readonly ttl?: Duration.Duration;
    readonly label?: string;
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly subject?: string;
  }) => Effect.Effect<IssuedPairingLink, ServerAuthInternalError>;
  readonly issuePairingCredential: (
    input?: AuthCreatePairingCredentialInput,
  ) => Effect.Effect<AuthPairingCredentialResult, ServerAuthInternalError>;
  readonly issueStartupPairingCredential: () => Effect.Effect<
    AuthPairingCredentialResult,
    ServerAuthInternalError
  >;
  readonly listPairingLinks: (input?: {
    readonly excludeSubjects?: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<AuthPairingLink>, ServerAuthInternalError>;
  readonly revokePairingLink: (id: string) => Effect.Effect<boolean, ServerAuthInternalError>;
  readonly issueSession: (input?: {
    readonly ttl?: Duration.Duration;
    readonly subject?: string;
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly label?: string;
  }) => Effect.Effect<IssuedBearerSession, ServerAuthInternalError>;
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<AuthClientSession>,
    ServerAuthInternalError
  >;
  readonly revokeSession: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<boolean, ServerAuthInternalError>;
  readonly revokeOtherSessionsExcept: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<number, ServerAuthInternalError>;
  readonly listClientSessions: (
    currentSessionId: AuthSessionId,
  ) => Effect.Effect<ReadonlyArray<AuthClientSession>, ServerAuthInternalError>;
  readonly revokeClientSession: (
    currentSessionId: AuthSessionId,
    targetSessionId: AuthSessionId,
  ) => Effect.Effect<boolean, ServerAuthForbiddenOperationError | ServerAuthInternalError>;
  readonly revokeOtherClientSessions: (
    currentSessionId: AuthSessionId,
  ) => Effect.Effect<number, ServerAuthInternalError>;
  readonly authenticateHttpRequest: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<
    AuthenticatedSession,
    ServerAuthInvalidCredentialError | ServerAuthInternalError
  >;
  readonly authenticateWebSocketUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<
    AuthenticatedSession,
    ServerAuthInvalidCredentialError | ServerAuthInternalError
  >;
  readonly issueWebSocketTicket: (
    session: Pick<AuthenticatedSession, "sessionId">,
  ) => Effect.Effect<AuthWebSocketTicketResult, ServerAuthInternalError>;
  readonly issueStartupPairingUrl: (
    baseUrl: string,
  ) => Effect.Effect<string, ServerAuthInternalError>;
}

export class EnvironmentAuth extends Context.Service<EnvironmentAuth, EnvironmentAuthShape>()(
  "t3/auth/EnvironmentAuth",
) {}

type BootstrapExchangeResult = {
  readonly response: AuthBrowserSessionResult;
  readonly sessionToken: string;
};

const AUTHORIZATION_PREFIX = "Bearer ";
const WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";

const bySessionPriority = (left: AuthClientSession, right: AuthClientSession) => {
  const leftCanManage = left.scopes.includes(AuthAccessWriteScope);
  const rightCanManage = right.scopes.includes(AuthAccessWriteScope);
  if (leftCanManage !== rightCanManage) {
    return leftCanManage ? -1 : 1;
  }
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }
  return right.issuedAt.epochMilliseconds - left.issuedAt.epochMilliseconds;
};

const toInternalError =
  (message: string) =>
  (cause: unknown): ServerAuthInternalError =>
    new ServerAuthInternalError({ message, cause });

export function toBootstrapExchangeError(
  cause: PairingGrantStore.BootstrapCredentialError,
): ServerAuthInvalidCredentialError | ServerAuthInternalError {
  if (cause._tag === "BootstrapCredentialInternalError") {
    return new ServerAuthInternalError({
      message: "Failed to validate bootstrap credential.",
      cause,
    });
  }

  return new ServerAuthInvalidCredentialError({
    reason: "invalid_credential",
    cause,
  });
}

const mapSessionVerificationErrors = <A, R>(
  effect: Effect.Effect<A, SessionStore.SessionCredentialError, R>,
): Effect.Effect<A, ServerAuthInvalidCredentialError | ServerAuthInternalError, R> =>
  effect.pipe(
    Effect.catchTags({
      SessionCredentialInvalidError: (cause) =>
        Effect.fail(new ServerAuthInvalidCredentialError({ reason: "invalid_credential", cause })),
      SessionCredentialInternalError: (cause) =>
        Effect.fail(
          new ServerAuthInternalError({
            message: "Failed to validate session credential.",
            cause,
          }),
        ),
    }),
  );

function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(AUTHORIZATION_PREFIX)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export const make = Effect.fn("makeEnvironmentAuth")(function* () {
  const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
  const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
  const sessions = yield* SessionStore.SessionStore;
  const descriptor = yield* policy.getDescriptor();

  const authenticateToken = (
    token: string,
  ): Effect.Effect<
    AuthenticatedSession,
    ServerAuthInvalidCredentialError | ServerAuthInternalError
  > =>
    sessions.verify(token).pipe(
      Effect.tapErrorTag("SessionCredentialInvalidError", (cause) =>
        Effect.logWarning("Rejected authenticated session credential.").pipe(
          Effect.annotateLogs({
            reason: cause.message,
          }),
        ),
      ),
      Effect.map((session) => ({
        sessionId: session.sessionId,
        subject: session.subject,
        method: session.method,
        scopes: session.scopes,
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      })),
      mapSessionVerificationErrors,
    );

  const authenticateRequest = (request: HttpServerRequest.HttpServerRequest) => {
    const cookieToken = request.cookies[sessions.cookieName];
    const bearerToken = parseBearerToken(request);
    const credential = cookieToken ?? bearerToken;
    if (!credential) {
      return Effect.fail(new ServerAuthInvalidCredentialError({ reason: "missing_credential" }));
    }
    return authenticateToken(credential);
  };

  const getSessionState: EnvironmentAuthShape["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            auth: descriptor,
            scopes: session.scopes,
            sessionMethod: session.method,
            ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
          }) satisfies AuthSessionState,
      ),
      Effect.catchTag("ServerAuthInvalidCredentialError", () =>
        Effect.succeed({
          authenticated: false,
          auth: descriptor,
        } satisfies AuthSessionState),
      ),
      Effect.withSpan("EnvironmentAuth.getSessionState"),
    );

  const createBrowserSession: EnvironmentAuthShape["createBrowserSession"] = (
    credential,
    requestMetadata,
  ) =>
    bootstrapCredentials.consume(credential).pipe(
      Effect.mapError(toBootstrapExchangeError),
      Effect.flatMap((grant) =>
        sessions
          .issue({
            method: "browser-session-cookie",
            subject: grant.subject,
            scopes: grant.scopes,
            client: {
              ...requestMetadata,
              ...(grant.label ? { label: grant.label } : {}),
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ServerAuthInternalError({
                  message: "Failed to issue authenticated session.",
                  cause,
                }),
            ),
          ),
      ),
      Effect.map(
        (session) =>
          ({
            response: {
              authenticated: true,
              scopes: session.scopes,
              sessionMethod: session.method,
              expiresAt: DateTime.toUtc(session.expiresAt),
            } satisfies AuthBrowserSessionResult,
            sessionToken: session.token,
          }) satisfies BootstrapExchangeResult,
      ),
      Effect.withSpan("EnvironmentAuth.createBrowserSession"),
    );

  const exchangeBootstrapCredentialForAccessToken: EnvironmentAuthShape["exchangeBootstrapCredentialForAccessToken"] =
    (credential, requestedScopes, requestMetadata) =>
      bootstrapCredentials.consume(credential).pipe(
        Effect.mapError(toBootstrapExchangeError),
        Effect.flatMap((grant) =>
          Effect.gen(function* () {
            const grantedScopes = requestedScopes ?? grant.scopes;
            if (!grantedScopes.every((scope) => grant.scopes.includes(scope))) {
              return yield* new ServerAuthInvalidRequestError({
                reason: "scope_not_granted",
              });
            }
            return yield* sessions
              .issue({
                method: "bearer-access-token",
                subject: grant.subject,
                scopes: grantedScopes,
                client: {
                  ...requestMetadata,
                  ...(grant.label ? { label: grant.label } : {}),
                },
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerAuthInternalError({
                      message: "Failed to issue authenticated access token.",
                      cause,
                    }),
                ),
              );
          }),
        ),
        Effect.flatMap((session) =>
          DateTime.now.pipe(
            Effect.map(
              (now) =>
                ({
                  access_token: session.token,
                  issued_token_type: AuthAccessTokenType,
                  token_type: "Bearer",
                  expires_in: Math.max(
                    0,
                    Math.floor(
                      (session.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1000,
                    ),
                  ),
                  scope: encodeOAuthScope(session.scopes),
                }) satisfies AuthAccessTokenResult,
            ),
          ),
        ),
        Effect.withSpan("EnvironmentAuth.exchangeBootstrapCredentialForAccessToken"),
      );

  const issuePairingCredentialForSubject = (input: {
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly subject: string;
    readonly label?: string;
  }) =>
    createPairingLink({
      scopes: input.scopes,
      subject: input.subject,
      ...(input.label ? { label: input.label } : {}),
    }).pipe(
      Effect.map(
        (issued) =>
          ({
            id: issued.id,
            credential: issued.credential,
            ...(issued.label ? { label: issued.label } : {}),
            expiresAt: issued.expiresAt,
          }) satisfies AuthPairingCredentialResult,
      ),
    );

  const createPairingLink: EnvironmentAuthShape["createPairingLink"] = Effect.fn(
    "EnvironmentAuth.createPairingLink",
  )(
    function* (input) {
      const createdAt = yield* DateTime.now;
      const issued = yield* bootstrapCredentials.issueOneTimeToken({
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        ...(input?.ttl ? { ttl: input.ttl } : {}),
        ...(input?.label ? { label: input.label } : {}),
      });
      return {
        id: issued.id,
        credential: issued.credential,
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        ...(issued.label ? { label: issued.label } : {}),
        createdAt: DateTime.toUtc(createdAt),
        expiresAt: DateTime.toUtc(issued.expiresAt),
      } satisfies IssuedPairingLink;
    },
    Effect.mapError(toInternalError("Failed to create pairing link.")),
  );

  const listPairingLinks: EnvironmentAuthShape["listPairingLinks"] = (input) =>
    bootstrapCredentials.listActive().pipe(
      Effect.map((pairingLinks) => {
        const excludedSubjects = input?.excludeSubjects ?? [
          INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        ];
        return pairingLinks
          .filter((pairingLink) => !excludedSubjects.includes(pairingLink.subject))
          .toSorted(
            (left, right) => right.createdAt.epochMilliseconds - left.createdAt.epochMilliseconds,
          );
      }),
      Effect.mapError(toInternalError("Failed to list pairing links.")),
      Effect.withSpan("EnvironmentAuth.listPairingLinks"),
    );

  const revokePairingLink: EnvironmentAuthShape["revokePairingLink"] = (id) =>
    bootstrapCredentials
      .revoke(id)
      .pipe(
        Effect.mapError(toInternalError("Failed to revoke pairing link.")),
        Effect.withSpan("EnvironmentAuth.revokePairingLink"),
      );

  const issueSession: EnvironmentAuthShape["issueSession"] = (input) =>
    sessions
      .issue({
        subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
        method: "bearer-access-token",
        scopes: input?.scopes ?? AuthAdministrativeScopes,
        client: {
          ...(input?.label ? { label: input.label } : {}),
          deviceType: "bot",
        },
        ...(input?.ttl ? { ttl: input.ttl } : {}),
      })
      .pipe(
        Effect.map(
          (issued) =>
            ({
              sessionId: issued.sessionId,
              token: issued.token,
              method: "bearer-access-token",
              scopes: issued.scopes,
              subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
              client: issued.client,
              expiresAt: DateTime.toUtc(issued.expiresAt),
            }) satisfies IssuedBearerSession,
        ),
        Effect.mapError(toInternalError("Failed to issue session token.")),
        Effect.withSpan("EnvironmentAuth.issueSession"),
      );

  const listSessions: EnvironmentAuthShape["listSessions"] = () =>
    sessions.listActive().pipe(
      Effect.map((activeSessions) => activeSessions.toSorted(bySessionPriority)),
      Effect.mapError(toInternalError("Failed to list sessions.")),
      Effect.withSpan("EnvironmentAuth.listSessions"),
    );

  const revokeSession: EnvironmentAuthShape["revokeSession"] = (sessionId) =>
    sessions
      .revoke(sessionId)
      .pipe(
        Effect.mapError(toInternalError("Failed to revoke session.")),
        Effect.withSpan("EnvironmentAuth.revokeSession"),
      );

  const revokeOtherSessionsExcept: EnvironmentAuthShape["revokeOtherSessionsExcept"] = (
    sessionId,
  ) =>
    sessions
      .revokeAllExcept(sessionId)
      .pipe(
        Effect.mapError(toInternalError("Failed to revoke other sessions.")),
        Effect.withSpan("EnvironmentAuth.revokeOtherSessionsExcept"),
      );

  const issuePairingCredential: EnvironmentAuthShape["issuePairingCredential"] = (input) =>
    issuePairingCredentialForSubject({
      scopes: input?.scopes ?? AuthStandardClientScopes,
      subject: "one-time-token",
      ...(input?.label ? { label: input.label } : {}),
    }).pipe(Effect.withSpan("EnvironmentAuth.issuePairingCredential"));

  const issueStartupPairingCredential: EnvironmentAuthShape["issueStartupPairingCredential"] = () =>
    issuePairingCredentialForSubject({
      scopes: AuthAdministrativeScopes,
      subject: INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
    }).pipe(Effect.withSpan("EnvironmentAuth.issueStartupPairingCredential"));

  const listClientSessions: EnvironmentAuthShape["listClientSessions"] = (currentSessionId) =>
    listSessions().pipe(
      Effect.map((clientSessions) =>
        clientSessions.map(
          (clientSession): AuthClientSession => ({
            ...clientSession,
            current: clientSession.sessionId === currentSessionId,
          }),
        ),
      ),
      Effect.withSpan("EnvironmentAuth.listClientSessions"),
    );

  const revokeClientSession: EnvironmentAuthShape["revokeClientSession"] = Effect.fn(
    "EnvironmentAuth.revokeClientSession",
  )(function* (currentSessionId, targetSessionId) {
    if (currentSessionId === targetSessionId) {
      return yield* new ServerAuthForbiddenOperationError({
        reason: "current_session_revoke_not_allowed",
      });
    }
    return yield* revokeSession(targetSessionId);
  });

  const revokeOtherClientSessions: EnvironmentAuthShape["revokeOtherClientSessions"] = (
    currentSessionId,
  ) =>
    revokeOtherSessionsExcept(currentSessionId).pipe(
      Effect.withSpan("EnvironmentAuth.revokeOtherClientSessions"),
    );

  const issueStartupPairingUrl: EnvironmentAuthShape["issueStartupPairingUrl"] = (baseUrl) =>
    issueStartupPairingCredential().pipe(
      Effect.map((issued) => {
        const url = new URL(baseUrl);
        url.pathname = "/pair";
        url.searchParams.delete("token");
        url.hash = new URLSearchParams([["token", issued.credential]]).toString();
        return url.toString();
      }),
      Effect.withSpan("EnvironmentAuth.issueStartupPairingUrl"),
    );

  const issueWebSocketTicket: EnvironmentAuthShape["issueWebSocketTicket"] = (session) =>
    sessions.issueWebSocketToken(session.sessionId).pipe(
      Effect.mapError(
        (cause) =>
          new ServerAuthInternalError({
            message: "Failed to issue websocket token.",
            cause,
          }),
      ),
      Effect.map(
        (issued) =>
          ({
            ticket: issued.token,
            expiresAt: DateTime.toUtc(issued.expiresAt),
          }) satisfies AuthWebSocketTicketResult,
      ),
      Effect.withSpan("EnvironmentAuth.issueWebSocketTicket"),
    );

  const authenticateHttpRequest: EnvironmentAuthShape["authenticateHttpRequest"] = (request) =>
    authenticateRequest(request).pipe(Effect.withSpan("EnvironmentAuth.authenticateHttpRequest"));

  const authenticateWebSocketUpgrade: EnvironmentAuthShape["authenticateWebSocketUpgrade"] =
    Effect.fn("EnvironmentAuth.authenticateWebSocketUpgrade")(function* (request) {
      const requestUrl = HttpServerRequest.toURL(request);
      if (Option.isSome(requestUrl)) {
        const websocketTicket = requestUrl.value.searchParams.get(WEBSOCKET_TICKET_QUERY_PARAM);
        if (websocketTicket && websocketTicket.trim().length > 0) {
          return yield* sessions.verifyWebSocketToken(websocketTicket).pipe(
            Effect.map((session) => ({
              sessionId: session.sessionId,
              subject: session.subject,
              method: session.method,
              scopes: session.scopes,
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            })),
            mapSessionVerificationErrors,
          );
        }
      }

      return yield* authenticateRequest(request);
    });

  return {
    getDescriptor: () =>
      Effect.succeed(descriptor).pipe(Effect.withSpan("EnvironmentAuth.getDescriptor")),
    getSessionState,
    createBrowserSession,
    exchangeBootstrapCredentialForAccessToken,
    createPairingLink,
    issuePairingCredential,
    issueStartupPairingCredential,
    listPairingLinks,
    revokePairingLink,
    issueSession,
    listSessions,
    revokeSession,
    revokeOtherSessionsExcept,
    listClientSessions,
    revokeClientSession,
    revokeOtherClientSessions,
    authenticateHttpRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketTicket,
    issueStartupPairingUrl,
  } satisfies EnvironmentAuthShape;
});

export const layer = Layer.effect(EnvironmentAuth, make()).pipe(
  Layer.provideMerge(PairingGrantStore.layer),
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(EnvironmentAuthPolicy.layer),
);

export const storageLayer = Layer.mergeAll(ServerSecretStore.layer, SqlitePersistenceLayer);

export const runtimeLayer = layer.pipe(Layer.provideMerge(storageLayer));
