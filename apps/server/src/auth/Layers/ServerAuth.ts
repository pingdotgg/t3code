import {
  AuthAccessTokenType,
  type AuthAccessTokenResult,
  type AuthBearerBootstrapResult,
  type AuthClientSession,
  type AuthBootstrapResult,
  type AuthPairingCredentialResult,
  type AuthSessionState,
  type AuthWebSocketTokenResult,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import { DateTime, Duration, Effect, Layer, Option } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { AuthControlPlane } from "../Services/AuthControlPlane.ts";
import { verifyAndConsumeDpopProof } from "../DpopReplayGuard.ts";
import { resolveReusableDevAuth } from "../ReusableDevAuth.ts";
import { ServerConfig } from "../../config.ts";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy.ts";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService.ts";
import { BootstrapCredentialError } from "../Services/BootstrapCredentialService.ts";
import { ServerAuthPolicy } from "../Services/ServerAuthPolicy.ts";
import {
  ServerAuth,
  type AuthenticatedSession,
  AuthError,
  type ServerAuthShape,
} from "../Services/ServerAuth.ts";
import {
  SessionCredentialError,
  SessionCredentialService,
} from "../Services/SessionCredentialService.ts";
import { AuthControlPlaneLive, AuthCoreLive } from "./AuthControlPlane.ts";
import { defaultSessionScopes } from "../scopes.ts";

type BootstrapExchangeResult = {
  readonly response: AuthBootstrapResult;
  readonly sessionToken: string;
  readonly cookieName?: string;
};

const BEARER_AUTHORIZATION_PREFIX = "Bearer ";
const DPOP_AUTHORIZATION_PREFIX = "DPoP ";
const WEBSOCKET_TOKEN_QUERY_PARAM = "wsToken";
const WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";
const WEBSOCKET_TICKET_TTL_MS = 5 * 60 * 1_000;
const MAX_ISSUED_WEBSOCKET_TICKETS = 10_000;
const issuedWebSocketTickets = new Map<
  string,
  { readonly token: string; readonly expiresAt: number }
>();

function pruneExpiredWebSocketTickets(now: number): void {
  for (const [issuedTicket, credential] of issuedWebSocketTickets) {
    if (credential.expiresAt <= now) {
      issuedWebSocketTickets.delete(issuedTicket);
    }
  }
}

function consumeWebSocketTicket(ticket: string): string | null {
  pruneExpiredWebSocketTickets(Date.now());
  const credential = issuedWebSocketTickets.get(ticket);
  if (credential === undefined) {
    return null;
  }
  issuedWebSocketTickets.delete(ticket);
  return credential.token;
}

export function toBootstrapExchangeAuthError(cause: BootstrapCredentialError): AuthError {
  if (cause.status === 500) {
    return new AuthError({
      message: "Failed to validate bootstrap credential.",
      status: 500,
      cause,
    });
  }

  return new AuthError({
    message: "Invalid bootstrap credential.",
    status: 401,
    cause,
  });
}

type AuthorizationCredential =
  | { readonly _tag: "Bearer"; readonly token: string }
  | { readonly _tag: "Dpop"; readonly token: string };

function parseAuthorizationCredential(
  request: HttpServerRequest.HttpServerRequest,
): AuthorizationCredential | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string") {
    return null;
  }
  if (header.startsWith(BEARER_AUTHORIZATION_PREFIX)) {
    const token = header.slice(BEARER_AUTHORIZATION_PREFIX.length).trim();
    return token.length > 0 ? { _tag: "Bearer", token } : null;
  }
  if (header.startsWith(DPOP_AUTHORIZATION_PREFIX)) {
    const token = header.slice(DPOP_AUTHORIZATION_PREFIX.length).trim();
    return token.length > 0 ? { _tag: "Dpop", token } : null;
  }
  return null;
}

export const makeServerAuth = Effect.gen(function* () {
  const policy = yield* ServerAuthPolicy;
  const bootstrapCredentials = yield* BootstrapCredentialService;
  const authControlPlane = yield* AuthControlPlane;
  const sessions = yield* SessionCredentialService;
  const serverConfig = yield* ServerConfig;
  const descriptor = yield* policy.getDescriptor();
  const devAuth = resolveReusableDevAuth(serverConfig);

  const authenticateToken = (token: string): Effect.Effect<AuthenticatedSession, AuthError> =>
    sessions.verify(token).pipe(
      Effect.tapError((cause: SessionCredentialError) =>
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
        role: session.role,
        scopes: session.scopes,
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
        ...(session.proofKeyThumbprint ? { proofKeyThumbprint: session.proofKeyThumbprint } : {}),
      })),
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Unauthorized request.",
            status: 401,
            cause,
          }),
      ),
    );

  const authenticateRequest = (request: HttpServerRequest.HttpServerRequest) => {
    const cookieToken = request.cookies[sessions.cookieName];
    if (cookieToken) {
      return authenticateToken(cookieToken).pipe(
        Effect.flatMap((session) =>
          session.proofKeyThumbprint
            ? Effect.fail(
                new AuthError({
                  message: "Proof-bound access token cannot authenticate as a session cookie.",
                  status: 401,
                }),
              )
            : Effect.succeed(session),
        ),
      );
    }
    const authorization = parseAuthorizationCredential(request);
    if (!authorization) {
      // Reusable dev cookie is a last resort, never a fallback: a presented
      // normal credential (even a rejected one) fails closed above instead of
      // being retried against the dev token.
      const devCookieToken = devAuth ? request.cookies[devAuth.cookieName] : undefined;
      if (devCookieToken) {
        return authenticateToken(devCookieToken);
      }
      return Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      );
    }
    return authenticateToken(authorization.token).pipe(
      Effect.flatMap((session) => {
        if (authorization._tag === "Bearer") {
          return session.proofKeyThumbprint
            ? Effect.fail(
                new AuthError({
                  message: "Proof-bound access token requires DPoP authorization.",
                  status: 401,
                }),
              )
            : Effect.succeed(session);
        }
        const requestUrl = HttpServerRequest.toURL(request);
        if (!session.proofKeyThumbprint || Option.isNone(requestUrl)) {
          return Effect.fail(
            new AuthError({
              message: "Invalid DPoP authorization.",
              status: 401,
            }),
          );
        }
        const verification = verifyAndConsumeDpopProof({
          proof: request.headers["dpop"],
          method: request.method,
          url: requestUrl.value.toString(),
          nowEpochSeconds: Math.floor(Date.now() / 1_000),
          expectedThumbprint: session.proofKeyThumbprint,
          expectedAccessToken: authorization.token,
        });
        return verification.ok
          ? Effect.succeed(session)
          : Effect.fail(
              new AuthError({
                message: "Invalid DPoP authorization.",
                status: 401,
              }),
            );
      }),
    );
  };

  const getSessionState: ServerAuthShape["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            auth: descriptor,
            role: session.role,
            scopes: session.scopes,
            sessionMethod: session.method,
            ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
          }) satisfies AuthSessionState,
      ),
      Effect.catchTag("AuthError", (error) => {
        const credentialError =
          error.cause instanceof SessionCredentialError ? error.cause : undefined;
        const hasPresentedCredential =
          Boolean(request.cookies[sessions.cookieName]) ||
          (typeof request.headers["authorization"] === "string" &&
            request.headers["authorization"].trim().length > 0);
        const unauthenticatedReason =
          credentialError?.reason ?? (hasPresentedCredential ? "invalid" : "missing");
        return Effect.succeed({
          authenticated: false,
          auth: descriptor,
          unauthenticatedReason,
        } satisfies AuthSessionState);
      }),
    );

  const exchangeBootstrapCredentialForAccessToken: ServerAuthShape["exchangeBootstrapCredentialForAccessToken"] =
    (credential, requestedScopes, requestMetadata, proofKeyThumbprint) =>
      bootstrapCredentials.consume(credential, proofKeyThumbprint).pipe(
        Effect.mapError(toBootstrapExchangeAuthError),
        Effect.flatMap((grant) => {
          if (grant.browserSessionOnly) {
            return Effect.fail(
              new AuthError({
                message: "This bootstrap credential can only establish a browser session.",
                status: 401,
              }),
            );
          }
          const allowedScopes = grant.scopes;
          const scopes = requestedScopes ?? allowedScopes;
          if (scopes.length === 0 || scopes.some((scope) => !allowedScopes.includes(scope))) {
            return Effect.fail(
              new AuthError({
                message: "Requested scopes are not granted by this pairing credential.",
                status: 400,
                environmentReason: "scope_not_granted",
              }),
            );
          }
          return sessions
            .issue({
              method: grant.proofKeyThumbprint ? "dpop-access-token" : "bearer-access-token",
              subject: grant.subject,
              role: grant.role,
              scopes,
              client: {
                ...requestMetadata,
                ...(grant.label ? { label: grant.label } : {}),
              },
              ...(grant.proofKeyThumbprint ? { proofKeyThumbprint: grant.proofKeyThumbprint } : {}),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AuthError({
                    message: "Failed to issue authenticated access token.",
                    cause,
                  }),
              ),
              Effect.flatMap((session) =>
                DateTime.now.pipe(
                  Effect.map(
                    (now) =>
                      ({
                        access_token: session.token,
                        issued_token_type: AuthAccessTokenType,
                        token_type: grant.proofKeyThumbprint ? "DPoP" : "Bearer",
                        expires_in: Math.max(
                          0,
                          Math.floor(
                            (session.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1_000,
                          ),
                        ),
                        scope: encodeOAuthScope(session.scopes),
                      }) satisfies AuthAccessTokenResult,
                  ),
                ),
              ),
            );
        }),
      );

  const exchangeBootstrapCredential: ServerAuthShape["exchangeBootstrapCredential"] = (
    credential,
    requestMetadata,
  ) => {
    // Pasting the reusable dev token into the pairing flow binds this browser
    // profile with the dedicated dev cookie (30-day expiry). The raw token
    // itself stays usable as a bearer credential; revoking the dev session or
    // rotating the env value invalidates both.
    if (devAuth?.matches(credential)) {
      return sessions.verify(credential).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Invalid bootstrap credential.",
              status: 401,
              cause,
            }),
        ),
        Effect.flatMap((session) =>
          DateTime.now.pipe(
            Effect.map(
              (now) =>
                ({
                  response: {
                    authenticated: true,
                    role: session.role,
                    sessionMethod: session.method,
                    expiresAt: DateTime.toUtc(DateTime.add(now, { days: 30 })),
                  } satisfies AuthBootstrapResult,
                  sessionToken: credential,
                  cookieName: devAuth.cookieName,
                }) satisfies BootstrapExchangeResult,
            ),
          ),
        ),
      );
    }
    return bootstrapCredentials.consume(credential).pipe(
      Effect.mapError(toBootstrapExchangeAuthError),
      Effect.flatMap((grant) => {
        const issueSession = sessions
          .issue({
            ...(grant.browserSessionOnly ? { ttl: Duration.hours(8) } : {}),
            method: "browser-session-cookie",
            subject: grant.subject,
            role: grant.role,
            scopes: grant.scopes,
            client: {
              ...requestMetadata,
              ...(grant.label ? { label: grant.label } : {}),
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Failed to issue authenticated session.",
                  cause,
                }),
            ),
          );
        if (!grant.browserSessionOnly) return issueSession;

        const authorizationRevoked = () =>
          new AuthError({
            message: "Preview authorization is no longer active.",
            status: 401,
          });
        return bootstrapCredentials.isTransientSubjectRevoked(grant.subject).pipe(
          Effect.flatMap((revoked) =>
            revoked ? Effect.fail(authorizationRevoked()) : issueSession,
          ),
          Effect.flatMap((session) =>
            bootstrapCredentials.isTransientSubjectRevoked(grant.subject).pipe(
              Effect.flatMap((revoked) =>
                revoked
                  ? sessions.revoke(session.sessionId).pipe(
                      Effect.mapError(
                        (cause) =>
                          new AuthError({
                            message:
                              "Failed to revoke a session after preview authorization ended.",
                            cause,
                          }),
                      ),
                      Effect.andThen(Effect.fail(authorizationRevoked())),
                    )
                  : Effect.succeed(session),
              ),
            ),
          ),
        );
      }),
      Effect.map(
        (session) =>
          ({
            response: {
              authenticated: true,
              role: session.role,
              sessionMethod: session.method,
              expiresAt: DateTime.toUtc(session.expiresAt),
            } satisfies AuthBootstrapResult,
            sessionToken: session.token,
          }) satisfies BootstrapExchangeResult,
      ),
    );
  };

  const exchangeBootstrapCredentialForBearerSession: ServerAuthShape["exchangeBootstrapCredentialForBearerSession"] =
    (credential, requestMetadata) =>
      bootstrapCredentials.consume(credential).pipe(
        Effect.mapError(toBootstrapExchangeAuthError),
        Effect.flatMap((grant) => {
          if (grant.browserSessionOnly) {
            return Effect.fail(
              new AuthError({
                message: "This bootstrap credential can only establish a browser session.",
                status: 401,
              }),
            );
          }
          return sessions
            .issue({
              method: "bearer-session-token",
              subject: grant.subject,
              role: grant.role,
              scopes: grant.scopes,
              client: {
                ...requestMetadata,
                ...(grant.label ? { label: grant.label } : {}),
              },
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AuthError({
                    message: "Failed to issue authenticated session.",
                    cause,
                  }),
              ),
            );
        }),
        Effect.map(
          (session) =>
            ({
              authenticated: true,
              role: session.role,
              sessionMethod: "bearer-session-token",
              expiresAt: DateTime.toUtc(session.expiresAt),
              sessionToken: session.token,
            }) satisfies AuthBearerBootstrapResult,
        ),
      );

  const issuePairingCredential: ServerAuthShape["issuePairingCredential"] = (input) =>
    Effect.gen(function* () {
      const role = input?.role ?? "client";
      const allowedScopes = defaultSessionScopes(role);
      const scopes = input?.scopes ?? allowedScopes;
      if (scopes.length === 0 || scopes.some((scope) => !allowedScopes.includes(scope))) {
        return yield* new AuthError({
          message: "Requested pairing scopes are not granted for this role.",
          status: 400,
          environmentReason: "scope_not_granted",
        });
      }
      return yield* authControlPlane.createPairingLink({
        role,
        scopes,
        subject: role === "owner" ? "owner-bootstrap" : "one-time-token",
        ...(input?.label ? { label: input.label } : {}),
        ...(input?.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
      });
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof AuthError
          ? cause
          : new AuthError({
              message: "Failed to issue pairing credential.",
              cause,
            }),
      ),
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

  const listPairingLinks: ServerAuthShape["listPairingLinks"] = () =>
    authControlPlane
      .listPairingLinks({
        role: "client",
        excludeSubjects: ["owner-bootstrap"],
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to load pairing links.",
              cause,
            }),
        ),
      );

  const revokePairingLink: ServerAuthShape["revokePairingLink"] = (id) =>
    authControlPlane.revokePairingLink(id).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to revoke pairing link.",
            cause,
          }),
      ),
    );

  const listClientSessions: ServerAuthShape["listClientSessions"] = (currentSessionId) =>
    authControlPlane.listSessions().pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to load paired clients.",
            cause,
          }),
      ),
      Effect.map((clientSessions) =>
        clientSessions.map(
          (clientSession): AuthClientSession => ({
            ...clientSession,
            current: clientSession.sessionId === currentSessionId,
          }),
        ),
      ),
    );

  const revokeClientSession: ServerAuthShape["revokeClientSession"] = (
    currentSessionId,
    targetSessionId,
  ) =>
    Effect.gen(function* () {
      if (currentSessionId === targetSessionId) {
        return yield* new AuthError({
          message: "Use revoke other clients to keep the current owner session active.",
          status: 403,
        });
      }
      return yield* authControlPlane.revokeSession(targetSessionId).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to revoke client session.",
              cause,
            }),
        ),
      );
    });

  const revokeOtherClientSessions: ServerAuthShape["revokeOtherClientSessions"] = (
    currentSessionId,
  ) =>
    authControlPlane.revokeOtherSessionsExcept(currentSessionId).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to revoke other client sessions.",
            cause,
          }),
      ),
    );

  const issueStartupPairingUrl: ServerAuthShape["issueStartupPairingUrl"] = (baseUrl) =>
    issuePairingCredential({ role: "owner" }).pipe(
      Effect.map((issued) => {
        const url = new URL(baseUrl);
        url.pathname = "/pair";
        url.searchParams.delete("token");
        url.hash = new URLSearchParams([["token", issued.credential]]).toString();
        return url.toString();
      }),
    );

  const issueSessionWebSocketToken = (session: AuthenticatedSession) =>
    sessions.issueWebSocketToken(session.sessionId).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to issue websocket token.",
            cause,
          }),
      ),
      Effect.map(
        (issued) =>
          ({
            token: issued.token,
            expiresAt: DateTime.toUtc(issued.expiresAt),
          }) satisfies AuthWebSocketTokenResult,
      ),
    );

  const issueWebSocketToken: ServerAuthShape["issueWebSocketToken"] = (session) =>
    session.proofKeyThumbprint
      ? Effect.fail(
          new AuthError({
            message: "Proof-bound sessions must use websocket tickets.",
            status: 403,
          }),
        )
      : issueSessionWebSocketToken(session);

  const issueWebSocketTicket: ServerAuthShape["issueWebSocketTicket"] = (session) =>
    issueSessionWebSocketToken(session).pipe(
      Effect.map((issued) => {
        const now = Date.now();
        pruneExpiredWebSocketTickets(now);
        if (issuedWebSocketTickets.size >= MAX_ISSUED_WEBSOCKET_TICKETS) {
          const oldestTicket = issuedWebSocketTickets.keys().next().value;
          if (oldestTicket !== undefined) {
            issuedWebSocketTickets.delete(oldestTicket);
          }
        }
        const ticket = crypto.randomUUID();
        issuedWebSocketTickets.set(ticket, {
          token: issued.token,
          expiresAt: now + WEBSOCKET_TICKET_TTL_MS,
        });
        return { ticket, expiresAt: issued.expiresAt };
      }),
    );

  const authenticateWebSocketUpgrade: ServerAuthShape["authenticateWebSocketUpgrade"] = (request) =>
    Effect.gen(function* () {
      const requestUrl = HttpServerRequest.toURL(request);
      if (Option.isSome(requestUrl)) {
        const websocketTicket = requestUrl.value.searchParams.get(WEBSOCKET_TICKET_QUERY_PARAM);
        const websocketToken =
          websocketTicket === null
            ? requestUrl.value.searchParams.get(WEBSOCKET_TOKEN_QUERY_PARAM)
            : consumeWebSocketTicket(websocketTicket);
        if (websocketTicket !== null && websocketToken === null) {
          return yield* new AuthError({
            message: "Unauthorized request.",
            status: 401,
          });
        }
        if (websocketToken && websocketToken.trim().length > 0) {
          return yield* sessions.verifyWebSocketToken(websocketToken).pipe(
            Effect.map((session) => ({
              sessionId: session.sessionId,
              subject: session.subject,
              method: session.method,
              role: session.role,
              scopes: session.scopes,
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            })),
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Unauthorized request.",
                  status: 401,
                  cause,
                }),
            ),
          );
        }
      }

      return yield* authenticateRequest(request);
    });

  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState,
    exchangeBootstrapCredential,
    exchangeBootstrapCredentialForBearerSession,
    exchangeBootstrapCredentialForAccessToken,
    issuePairingCredential,
    listPairingLinks,
    revokePairingLink,
    listClientSessions,
    revokeClientSession,
    revokeOtherClientSessions,
    authenticateHttpRequest: authenticateRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketToken,
    issueWebSocketTicket,
    issueStartupPairingUrl,
  } satisfies ServerAuthShape;
});

export const ServerAuthLive = Layer.effect(ServerAuth, makeServerAuth).pipe(
  Layer.provideMerge(AuthControlPlaneLive),
  Layer.provideMerge(AuthCoreLive),
  Layer.provideMerge(ServerAuthPolicyLive),
);
