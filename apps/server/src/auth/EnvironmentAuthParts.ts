import {
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthStandardClientScopes,
  type AuthAccessTokenResult,
  type AuthBrowserSessionResult,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthCreatePairingCredentialInput,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  type AuthPairingLink,
  type AuthPairingCredentialResult,
  type AuthSessionId,
  type AuthSessionState,
  authScopeResponse,
  type ServerAuthDescriptor,
  type ServerAuthSessionMethod,
  type AuthWebSocketTicketResult,
  type AuthWebSocketTicketUse,
  DpopFailureReason,
  type DpopFailureReason as DpopFailureReasonType,
  mcpClientScopes,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { REUSABLE_DEV_SESSION_EXPIRES_AT, resolveReusableDevAuth } from "./ReusableDevAuth.ts";
import { verifyRequestDpopProof } from "./dpop.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { requestUrl } from "../requestUrl.ts";
import type { AuthenticatedSession, BootstrapExchangeResult, IssuedBearerSession, IssuedPairingLink, McpClientSession, ServerAuthCredentialError, ServerAuthInternalError } from "./EnvironmentAuth.ts";
import { DEFAULT_SESSION_SUBJECT, EnvironmentAuth, INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT, MCP_CLIENT_SESSION_TTL, MCP_CLIENT_SUBJECT, ServerAuthAuthenticatedAccessTokenIssueError, ServerAuthAuthenticatedSessionIssueError, ServerAuthForbiddenOperationError, ServerAuthInvalidCredentialError, ServerAuthMcpApprovalCodeError, ServerAuthMissingCredentialError, ServerAuthOtherSessionsRevocationError, ServerAuthPairingLinkCreationError, ServerAuthPairingLinkRevocationError, ServerAuthPairingLinksListError, ServerAuthScopeNotGrantedError, ServerAuthSessionCredentialValidationError, ServerAuthSessionRevocationError, ServerAuthSessionTokenIssueError, ServerAuthSessionsListError, ServerAuthWebSocketTokenIssueError, bySessionPriority, decodeWebSocketUpgradeQuery, isBrowserCookieCredential, isBrowserOriginAllowed, isServerAuthCredentialError, mapSessionVerificationErrors, parseBearerToken, parseDpopToken, rejectMcpClientAudience, revokePairedClientsThePolicyDisallows, selectRequestCredential, toBootstrapExchangeError } from "./EnvironmentAuth.ts";

export const make = Effect.gen(function* () {
  const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
  const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
  const sessions = yield* SessionStore.SessionStore;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const digest = yield* Digest.Digest;
  const descriptor = yield* policy.getDescriptor();
  const config = yield* ServerConfig.ServerConfig;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const devAuth = resolveReusableDevAuth(config);

  const authenticateToken = (
    token: string,
  ): Effect.Effect<
    AuthenticatedSession,
    ServerAuthInvalidCredentialError | ServerAuthInternalError
  > =>
    sessions.verify(token).pipe(
      Effect.tapError((cause) =>
        SessionStore.isSessionCredentialInvalidError(cause)
          ? Effect.logWarning("Rejected authenticated session credential.").pipe(
              Effect.annotateLogs({
                reason: cause.message,
              }),
            )
          : Effect.void,
      ),
      mapSessionVerificationErrors,
      Effect.flatMap(rejectMcpClientAudience),
      Effect.map((session) => ({
        sessionId: session.sessionId,
        subject: session.subject,
        method: session.method,
        scopes: session.scopes,
        ...(session.proofKeyThumbprint ? { proofKeyThumbprint: session.proofKeyThumbprint } : {}),
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      })),
    );

  const resolveRequestCredential = (request: HttpServerRequest.HttpServerRequest) => {
    const selectedCredential = selectRequestCredential(
      request,
      sessions.cookieName,
      sessions.legacyCookieName,
    );
    const hasAuthorization = request.headers.authorization !== undefined;
    const devCookieToken = devAuth ? request.cookies[devAuth.cookieName] : undefined;
    return (
      selectedCredential ??
      (!hasAuthorization && devCookieToken !== undefined
        ? { token: devCookieToken, source: "dev-cookie" as const }
        : undefined)
    );
  };

  // Cookies span ports; reject cookie-authenticated requests and sockets from other same-site origins.
  const trustedBrowserOrigins = new Set<string>([
    ...(config.devUrl ? [config.devUrl.origin] : []),
    ...DESKTOP_RENDERER_ORIGINS,
    ...config.devAllowedOrigins,
  ]);

  const authenticateRequest = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError> => {
    const dpopToken = parseDpopToken(request);
    const credential = resolveRequestCredential(request);
    if (!credential?.token) {
      return Effect.fail(new ServerAuthMissingCredentialError({}));
    }
    if (
      isBrowserCookieCredential(credential.source) &&
      !isBrowserOriginAllowed(request, trustedBrowserOrigins)
    ) {
      return Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "Browser sessions are only accepted from the app's own origin.",
        }),
      );
    }
    return authenticateToken(credential.token).pipe(
      Effect.flatMap((session) => {
        if (session.proofKeyThumbprint) {
          if (!dpopToken || dpopToken !== credential.token) {
            return Effect.fail(
              new ServerAuthInvalidCredentialError({
                diagnostic: "DPoP-bound access token requires DPoP authorization.",
                dpopFailureReason: "invalid_proof",
              }),
            );
          }
          return verifyRequestDpopProof({
            request,
            expectedThumbprint: session.proofKeyThumbprint,
            expectedAccessToken: dpopToken,
          }).pipe(
            Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
            Effect.provideService(Digest.Digest, digest),
            Effect.as(session),
          );
        }
        if (dpopToken) {
          return Effect.fail(
            new ServerAuthInvalidCredentialError({
              diagnostic: "DPoP authorization requires a proof-bound access token.",
              dpopFailureReason: "invalid_proof",
            }),
          );
        }
        return Effect.succeed(session);
      }),
    );
  };

  const getSessionState: EnvironmentAuth["Service"]["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            auth: descriptor,
            ...authScopeResponse(session.scopes),
            sessionMethod: session.method,
            ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
          }) satisfies AuthSessionState,
      ),
      Effect.catchIf(isServerAuthCredentialError, () =>
        Effect.succeed({
          authenticated: false,
          auth: descriptor,
        } satisfies AuthSessionState),
      ),
      Effect.withSpan("EnvironmentAuth.getSessionState"),
    );

  const createBrowserSession: EnvironmentAuth["Service"]["createBrowserSession"] = Effect.fn(
    "EnvironmentAuth.createBrowserSession",
  )(function* (credential, requestMetadata, previousSessionToken) {
    if (devAuth?.matches(credential)) {
      return yield* sessions.verify(credential).pipe(
        mapSessionVerificationErrors,
        Effect.flatMap((session) =>
          DateTime.now.pipe(
            Effect.map(
              (now) =>
                ({
                  response: {
                    authenticated: true,
                    ...authScopeResponse(session.scopes),
                    sessionMethod: session.method,
                    expiresAt: DateTime.toUtc(DateTime.add(now, { days: 30 })),
                  } satisfies AuthBrowserSessionResult,
                  sessionToken: credential,
                  cookieName: devAuth.cookieName,
                  expireNormalCookie: true,
                }) satisfies BootstrapExchangeResult,
            ),
          ),
        ),
        Effect.withSpan("EnvironmentAuth.createBrowserSession"),
      );
    }
    const previousSession =
      previousSessionToken === undefined
        ? undefined
        : yield* sessions.verify(previousSessionToken).pipe(
            Effect.catchIf(SessionStore.isSessionCredentialInvalidError, () => Effect.void),
            Effect.mapError((cause) => new ServerAuthSessionCredentialValidationError({ cause })),
          );
    const grant = yield* bootstrapCredentials
      .consume(credential)
      .pipe(Effect.mapError(toBootstrapExchangeError));
    const session = yield* sessions
      .issue({
        method: "browser-session-cookie",
        subject: grant.subject,
        scopes: grant.scopes,
        ...(previousSession?.method === "browser-session-cookie"
          ? { replaceSessionId: previousSession.sessionId }
          : {}),
        client: {
          ...requestMetadata,
          ...(grant.label ? { label: grant.label } : {}),
        },
      })
      .pipe(Effect.mapError((cause) => new ServerAuthAuthenticatedSessionIssueError({ cause })));
    return {
      response: {
        authenticated: true,
        ...authScopeResponse(session.scopes),
        sessionMethod: session.method,
        expiresAt: DateTime.toUtc(session.expiresAt),
      } satisfies AuthBrowserSessionResult,
      sessionToken: session.token,
    } satisfies BootstrapExchangeResult;
  });

  type ResolvedBootstrapGrant = Pick<
    PairingGrantStore.BootstrapGrant,
    "scopes" | "subject" | "label"
  > & {
    readonly method: PairingGrantStore.BootstrapGrant["method"] | "reusable-dev-token";
  };
  const resolveBootstrapGrant = (
    credential: string,
    input?: {
      readonly proofKeyThumbprint?: string;
      readonly requestedScopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly requiredScopes?: ReadonlyArray<AuthEnvironmentScope>;
    },
  ): Effect.Effect<
    ResolvedBootstrapGrant,
    ServerAuthInvalidCredentialError | ServerAuthInternalError | ServerAuthScopeNotGrantedError
  > => {
    if (!devAuth?.matches(credential)) {
      return bootstrapCredentials
        .consume(credential, input)
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "BootstrapCredentialScopeNotGrantedError"
              ? new ServerAuthScopeNotGrantedError({})
              : toBootstrapExchangeError(cause),
          ),
        );
    }
    return sessions.verify(credential).pipe(
      mapSessionVerificationErrors,
      Effect.filterOrFail(
        (session) =>
          input?.requiredScopes === undefined ||
          input.requiredScopes.every((scope) => session.scopes.includes(scope)),
        () => new ServerAuthScopeNotGrantedError({}),
      ),
      Effect.map(
        (session) =>
          ({
            method: "reusable-dev-token",
            scopes: session.scopes,
            subject: "reusable-dev-token-child",
          }) satisfies ResolvedBootstrapGrant,
      ),
    );
  };

  const exchangeBootstrapCredentialForAccessToken: EnvironmentAuth["Service"]["exchangeBootstrapCredentialForAccessToken"] =
    (credential, requestedScopes, requestMetadata, input) => {
      return resolveBootstrapGrant(credential, {
        ...input,
        ...(requestedScopes !== undefined ? { requestedScopes } : {}),
      }).pipe(
        Effect.flatMap((grant) =>
          Effect.gen(function* () {
            const grantedScopes =
              requestedScopes === undefined
                ? grant.scopes
                : [...new Set(requestedScopes)].filter((scope) => grant.scopes.includes(scope));
            if (grantedScopes.length === 0) {
              return yield* new ServerAuthScopeNotGrantedError({});
            }
            return yield* sessions
              .issue({
                method: input?.proofKeyThumbprint ? "dpop-access-token" : "bearer-access-token",
                subject: grant.subject,
                scopes: grantedScopes,
                ...(input?.proofKeyThumbprint
                  ? {
                      proofKeyThumbprint: input.proofKeyThumbprint,
                      ttl: Duration.hours(1),
                    }
                  : {}),
                replaceActiveForSubjectAndMethod: grant.method === "desktop-bootstrap",
                client: {
                  ...requestMetadata,
                  ...(grant.label ? { label: grant.label } : {}),
                },
              })
              .pipe(
                Effect.mapError(
                  (cause) => new ServerAuthAuthenticatedAccessTokenIssueError({ cause }),
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
                  token_type: input?.proofKeyThumbprint ? "DPoP" : "Bearer",
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
    };

  const toPairingCredential = (issued: IssuedPairingLink): AuthPairingCredentialResult => ({
    id: issued.id,
    credential: issued.credential,
    ...(issued.label ? { label: issued.label } : {}),
    expiresAt: issued.expiresAt,
  });

  const issuePairingLink = Effect.fn("EnvironmentAuth.issuePairingLink")(
    function* (input: Parameters<EnvironmentAuth["Service"]["createPairingLink"]>[0]) {
      const createdAt = yield* DateTime.now;
      const issued = yield* bootstrapCredentials.issueOneTimeToken({
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        ...(input?.ttl ? { ttl: input.ttl } : {}),
        ...(input?.label ? { label: input.label } : {}),
        ...(input?.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
        ...(input?.purpose ? { purpose: input.purpose } : {}),
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
    Effect.mapError((cause) => new ServerAuthPairingLinkCreationError({ cause })),
  );

  const createPairingLink: EnvironmentAuth["Service"]["createPairingLink"] = Effect.fn(
    "EnvironmentAuth.createPairingLink",
  )(function* (input) {
    // The startup link is for a browser on this machine; every other link lets a device pair.
    if (input?.purpose !== "startup" && !ManagedLimits.allowsRemoteClients(managedPolicy)) {
      return yield* ManagedLimits.refuseRemoteClients(
        managedPolicy,
        "so this server cannot create pairing links",
      );
    }
    return yield* issuePairingLink(input);
  });

  const listPairingLinks: EnvironmentAuth["Service"]["listPairingLinks"] = (input) =>
    bootstrapCredentials.listActive().pipe(
      Effect.map((pairingLinks) => {
        const excludedSubjects = input?.excludeSubjects ?? [
          INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        ];
        return pairingLinks
          .filter((pairingLink) => !excludedSubjects.includes(pairingLink.subject))
          .map((link) => ({ ...link, ...authScopeResponse(link.scopes) }))
          .toSorted(
            (left, right) => right.createdAt.epochMilliseconds - left.createdAt.epochMilliseconds,
          );
      }),
      Effect.mapError((cause) => new ServerAuthPairingLinksListError({ cause })),
      Effect.withSpan("EnvironmentAuth.listPairingLinks"),
    );

  const revokePairingLink: EnvironmentAuth["Service"]["revokePairingLink"] = (id) =>
    bootstrapCredentials.revoke(id).pipe(
      Effect.mapError((cause) => new ServerAuthPairingLinkRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokePairingLink"),
    );

  const issueSession: EnvironmentAuth["Service"]["issueSession"] = (input) =>
    sessions
      .issue({
        subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
        method: "bearer-access-token",
        scopes: input?.scopes ?? AuthStandardClientScopes,
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
        Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })),
        Effect.withSpan("EnvironmentAuth.issueSession"),
      );

  const listSessions: EnvironmentAuth["Service"]["listSessions"] = () =>
    sessions.listActive().pipe(
      Effect.map((activeSessions) => activeSessions.toSorted(bySessionPriority)),
      Effect.mapError((cause) => new ServerAuthSessionsListError({ cause })),
      Effect.withSpan("EnvironmentAuth.listSessions"),
    );

  const revokeSession: EnvironmentAuth["Service"]["revokeSession"] = (sessionId) =>
    sessions.revoke(sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthSessionRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeSession"),
    );

  const revokeOtherSessionsExcept = (sessionId: AuthSessionId) =>
    sessions.revokeAllExcept(sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthOtherSessionsRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeOtherSessionsExcept"),
    );

  const issuePairingCredential: EnvironmentAuth["Service"]["issuePairingCredential"] = (input) =>
    createPairingLink({
      scopes: input?.scopes ?? AuthStandardClientScopes,
      subject: "one-time-token",
      ...(input?.label ? { label: input.label } : {}),
    }).pipe(
      Effect.map(toPairingCredential),
      Effect.withSpan("EnvironmentAuth.issuePairingCredential"),
    );

  const issueStartupPairingCredential: EnvironmentAuth["Service"]["issueStartupPairingCredential"] =
    () => {
      // Unguarded: startup already refused auth policies the managed policy leaves out.
      const fallback = issuePairingLink({
        scopes: AuthStandardClientScopes,
        subject: INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        purpose: "startup",
      }).pipe(Effect.map(toPairingCredential));
      if (!devAuth) {
        return fallback.pipe(Effect.withSpan("EnvironmentAuth.issueStartupPairingCredential"));
      }
      return sessions.verify(devAuth.credential).pipe(
        Effect.map(
          (session) =>
            ({
              id: session.sessionId,
              credential: devAuth.credential,
              label: "Reusable dev token",
              expiresAt: DateTime.toUtc(session.expiresAt ?? REUSABLE_DEV_SESSION_EXPIRES_AT),
            }) satisfies AuthPairingCredentialResult,
        ),
        Effect.catch((cause) =>
          SessionStore.isSessionCredentialInvalidError(cause)
            ? fallback
            : Effect.fail(new ServerAuthPairingLinkCreationError({ cause })),
        ),
        Effect.withSpan("EnvironmentAuth.issueStartupPairingCredential"),
      );
    };

  const listClientSessions: EnvironmentAuth["Service"]["listClientSessions"] = (currentSessionId) =>
    listSessions().pipe(
      Effect.map((clientSessions) =>
        clientSessions.map((clientSession): AuthClientSession => ({
          ...clientSession,
          ...authScopeResponse(clientSession.scopes),
          current: clientSession.sessionId === currentSessionId,
        })),
      ),
      Effect.withSpan("EnvironmentAuth.listClientSessions"),
    );

  const revokeClientSession: EnvironmentAuth["Service"]["revokeClientSession"] = Effect.fn(
    "EnvironmentAuth.revokeClientSession",
  )(function* (currentSessionId, targetSessionId) {
    if (currentSessionId === targetSessionId) {
      return yield* new ServerAuthForbiddenOperationError({});
    }
    return yield* revokeSession(targetSessionId);
  });

  const revokeOtherClientSessions: EnvironmentAuth["Service"]["revokeOtherClientSessions"] = (
    currentSessionId,
  ) =>
    revokeOtherSessionsExcept(currentSessionId).pipe(
      Effect.withSpan("EnvironmentAuth.revokeOtherClientSessions"),
    );

  const issueStartupPairingUrl: EnvironmentAuth["Service"]["issueStartupPairingUrl"] = (baseUrl) =>
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

  // Only the RPC socket's ticket is bound to the client's proof key. The media
  // routes reuse one ticket across <img>, EventSource and several sockets, and
  // each of those would need its own single-use proof.
  const issueWebSocketTicket: EnvironmentAuth["Service"]["issueWebSocketTicket"] = (
    session,
    input,
  ) =>
    sessions
      .issueWebSocketToken(session.sessionId, {
        ...(input?.use ? { audience: input.use } : {}),
        ...(input?.use === "rpc" && session.proofKeyThumbprint
          ? { proofKeyThumbprint: session.proofKeyThumbprint }
          : {}),
      })
      .pipe(
        Effect.mapError((cause) => new ServerAuthWebSocketTokenIssueError({ cause })),
        Effect.map(
          (issued) =>
            ({
              ticket: Redacted.make(issued.token),
              expiresAt: DateTime.toUtc(issued.expiresAt),
            }) satisfies AuthWebSocketTicketResult,
        ),
        Effect.withSpan("EnvironmentAuth.issueWebSocketTicket"),
      );

  const authenticateHttpRequest: EnvironmentAuth["Service"]["authenticateHttpRequest"] = (
    request,
  ) =>
    authenticateRequest(request).pipe(Effect.withSpan("EnvironmentAuth.authenticateHttpRequest"));

  const authenticateWebSocketUpgrade: EnvironmentAuth["Service"]["authenticateWebSocketUpgrade"] =
    Effect.fn("EnvironmentAuth.authenticateWebSocketUpgrade")(function* (request, use) {
      const url = requestUrl(request);
      if (Option.isSome(url)) {
        const query = yield* decodeWebSocketUpgradeQuery(
          Object.fromEntries(url.value.searchParams),
        ).pipe(Effect.orDie);
        const websocketTicket = query.wsTicket && Redacted.value(query.wsTicket);
        if (websocketTicket && websocketTicket.trim().length > 0) {
          const session = yield* sessions
            .verifyWebSocketToken(websocketTicket)
            .pipe(mapSessionVerificationErrors, Effect.flatMap(rejectMcpClientAudience));
          if (session.audience !== undefined && session.audience !== use) {
            return yield* new ServerAuthInvalidCredentialError({
              diagnostic: `WebSocket ticket was issued for the ${session.audience} route.`,
            });
          }
          if (session.proofKeyThumbprint) {
            // WebSocket clients cannot set headers, so the proof travels in the query.
            // The proof hashes the ticket; consuming its jti prevents replay after first use.
            // Only encrypted transport prevents an active interceptor from racing that use.
            const proof = request.headers.dpop ?? (query.dpop && Redacted.value(query.dpop));
            if (!proof) {
              return yield* new ServerAuthInvalidCredentialError({
                diagnostic: "DPoP-bound WebSocket ticket requires a DPoP proof.",
                dpopFailureReason: "invalid_proof",
              });
            }
            yield* verifyRequestDpopProof({
              request,
              proof,
              expectedThumbprint: session.proofKeyThumbprint,
              expectedAccessToken: websocketTicket,
            }).pipe(
              Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
              Effect.provideService(Digest.Digest, digest),
            );
          }
          return {
            sessionId: session.sessionId,
            subject: session.subject,
            method: session.method,
            scopes: session.scopes,
            ...(session.proofKeyThumbprint
              ? { proofKeyThumbprint: session.proofKeyThumbprint }
              : {}),
            ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
          };
        }
      }

      return yield* authenticateRequest(request);
    });

  const authenticateMcpClient: EnvironmentAuth["Service"]["authenticateMcpClient"] = (request) => {
    const token = parseBearerToken(request);
    if (token === null) return Effect.fail(new ServerAuthMissingCredentialError({}));
    return sessions.verify(token).pipe(
      mapSessionVerificationErrors,
      Effect.flatMap((session) =>
        session.subject === MCP_CLIENT_SUBJECT && session.method === "bearer-access-token"
          ? Effect.succeed({
              sessionId: session.sessionId,
              label: session.client.label ?? "MCP client",
              access: session.scopes.includes(AuthOrchestrationOperateScope)
                ? (session.runtimeModeCeiling ?? "approval-required")
                : "read-only",
              peerLink: session.peerLink === true,
            } satisfies McpClientSession)
          : Effect.fail(
              new ServerAuthInvalidCredentialError({
                diagnostic: "Only MCP client sessions are accepted here.",
              }),
            ),
      ),
      Effect.withSpan("EnvironmentAuth.authenticateMcpClient"),
    );
  };

  const issueMcpClientSession: EnvironmentAuth["Service"]["issueMcpClientSession"] = (input) =>
    sessions
      .issue({
        subject: MCP_CLIENT_SUBJECT,
        method: "bearer-access-token",
        scopes: mcpClientScopes(input.access),
        ttl: MCP_CLIENT_SESSION_TTL,
        ...(input.access === "read-only" ? {} : { runtimeModeCeiling: input.access }),
        peerLink: input.peerLink,
        client: { ...input.client, label: input.label, deviceType: "bot" },
      })
      .pipe(
        Effect.map((issued) => ({
          sessionId: issued.sessionId,
          token: issued.token,
          expiresAt: issued.expiresAt,
        })),
        Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })),
        Effect.withSpan("EnvironmentAuth.issueMcpClientSession"),
      );

  const authenticateBrowserSession: EnvironmentAuth["Service"]["authenticateBrowserSession"] = (
    request,
  ) => {
    const credential = resolveRequestCredential(request);
    if (!credential || !isBrowserCookieCredential(credential.source)) {
      return Effect.fail(new ServerAuthMissingCredentialError({}));
    }
    return authenticateRequest(request).pipe(
      Effect.filterOrFail(
        (session) => session.method === "browser-session-cookie",
        () => new ServerAuthInvalidCredentialError({ diagnostic: "Not a browser session." }),
      ),
      Effect.withSpan("EnvironmentAuth.authenticateBrowserSession"),
    );
  };

  const consumeMcpApprovalCode: EnvironmentAuth["Service"]["consumeMcpApprovalCode"] = (
    code,
    access,
  ) =>
    resolveBootstrapGrant(code.trim(), { requiredScopes: mcpClientScopes(access) }).pipe(
      Effect.catchTags({
        ServerAuthInvalidCredentialError: () =>
          Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "unknown_or_used" })),
        ServerAuthScopeNotGrantedError: () =>
          Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "insufficient_scope" })),
      }),
      Effect.flatMap((grant) =>
        grant.method !== "one-time-token" && grant.method !== "reusable-dev-token"
          ? Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "not_a_pairing_code" }))
          : Effect.void,
      ),
      Effect.withSpan("EnvironmentAuth.consumeMcpApprovalCode"),
    );

  yield* revokePairedClientsThePolicyDisallows(managedPolicy, {
    sessions,
    pairingLinks: bootstrapCredentials,
  });

  return EnvironmentAuth.of({
    getDescriptor: Effect.fn("EnvironmentAuth.getDescriptor")(function () {
      return Effect.succeed(descriptor);
    }),
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
    listClientSessions,
    revokeClientSession,
    revokeOtherClientSessions,
    authenticateHttpRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketTicket,
    issueStartupPairingUrl,
    authenticateMcpClient,
    issueMcpClientSession,
    consumeMcpApprovalCode,
    authenticateBrowserSession,
  });
});

/** Subjects of sessions and links a pairing link created, keyed by how the client paired. */
