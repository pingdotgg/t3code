import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthAccessTokenResult,
  AuthTokenExchangeRequest,
  type AuthBearerBootstrapResult,
  AuthBootstrapInput,
  AuthCreatePairingCredentialInput,
  type AuthEnvironmentScope,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentRequestInvalidError,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentScopeRequiredError,
  type AuthWebSocketTokenResult,
  type AuthWebSocketTicketResult,
} from "@t3tools/contracts";
import { parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import { DateTime, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError, ServerAuth } from "./Services/ServerAuth.ts";
import { SessionCredentialService } from "./Services/SessionCredentialService.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
import { ALL_AUTH_ENVIRONMENT_SCOPES, sessionScopeSet } from "./scopes.ts";

const makeTraceId = () => crypto.randomUUID().replaceAll("-", "");

export const requireSessionScope = (
  role: string,
  requiredScope: AuthEnvironmentScope,
  scopes?: ReadonlyArray<AuthEnvironmentScope>,
): Effect.Effect<void, AuthError> =>
  sessionScopeSet(role === "owner" ? "owner" : "client", scopes).has(requiredScope)
    ? Effect.void
    : Effect.fail(
        new AuthError({
          message: `Session is missing required scope: ${requiredScope}.`,
          status: 403,
        }),
      );

const toEnvironmentAuthError = (error: AuthError) =>
  error.status === 401
    ? new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: makeTraceId(),
      })
    : new EnvironmentInternalError({
        code: "internal_error",
        reason: "internal_error",
        traceId: makeTraceId(),
      });

export const environmentAuthenticatedAuthLayer = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    return EnvironmentAuthenticatedAuth.of((handler) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* serverAuth
          .authenticateHttpRequest(request)
          .pipe(Effect.mapError(toEnvironmentAuthError));
        const principal = EnvironmentAuthenticatedPrincipal.of({
          sessionId: session.sessionId,
          subject: session.subject,
          method: session.method,
          scopes: new Set(session.scopes),
          ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
        });
        return yield* handler.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, principal),
        );
      }),
    );
  }),
);

export const requireEnvironmentScope = (requiredScope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const principal = yield* EnvironmentAuthenticatedPrincipal;
    if (!principal.scopes.has(requiredScope)) {
      return yield* new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope,
        traceId: makeTraceId(),
      });
    }
  });

export const respondToAuthError = (error: AuthError) =>
  Effect.gen(function* () {
    if ((error.status ?? 500) >= 500) {
      yield* Effect.logError("auth route failed", {
        message: error.message,
        cause: error.cause,
      });
    }
    return HttpServerResponse.jsonUnsafe(
      {
        error: error.message,
      },
      { status: error.status ?? 500, headers: browserApiCorsHeaders },
    );
  });

export const authSessionRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/session",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.getSessionState(request);
    return HttpServerResponse.jsonUnsafe(session, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }),
);

const PairingCredentialRequestHeaders = Schema.Struct({
  "content-length": Schema.optionalKey(Schema.String),
  "content-type": Schema.optionalKey(Schema.String),
  "transfer-encoding": Schema.optionalKey(Schema.String),
});

function hasRequestBody(headers: typeof PairingCredentialRequestHeaders.Type) {
  const contentLengthHeader = headers["content-length"];
  if (typeof contentLengthHeader === "string") {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength)) {
      return contentLength > 0;
    }
  }
  return typeof headers["transfer-encoding"] === "string";
}

export const authBootstrapRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/bootstrap",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const sessions = yield* SessionCredentialService;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthBootstrapInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid bootstrap payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const result = yield* serverAuth.exchangeBootstrapCredential(
      payload.credential,
      deriveAuthClientMetadata({ request }),
    );

    return yield* HttpServerResponse.jsonUnsafe(result.response, {
      status: 200,
      headers: browserApiCorsHeaders,
    }).pipe(
      HttpServerResponse.setCookie(sessions.cookieName, result.sessionToken, {
        expires: DateTime.toDate(result.response.expiresAt),
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      }),
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authBearerBootstrapRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/bootstrap/bearer",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthBootstrapInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid bootstrap payload.",
            status: 400,
            cause,
          }),
      ),
    );

    const result = yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
      payload.credential,
      deriveAuthClientMetadata({ request }),
    );
    return HttpServerResponse.jsonUnsafe(result satisfies AuthBearerBootstrapResult, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

const credentialResponseHeaders = {
  ...browserApiCorsHeaders,
  "cache-control": "no-store",
  pragma: "no-cache",
};

const respondToEnvironmentAuthError = (error: AuthError) =>
  Effect.succeed(
    error.status === 400
      ? HttpServerResponse.jsonUnsafe(
          new EnvironmentRequestInvalidError({
            code: "invalid_request",
            reason: error.environmentReason ?? "invalid_scope",
            traceId: makeTraceId(),
          }),
          { status: 400, headers: credentialResponseHeaders },
        )
      : error.status === 401
        ? HttpServerResponse.jsonUnsafe(
            new EnvironmentAuthInvalidError({
              code: "auth_invalid",
              reason: "invalid_credential",
              traceId: makeTraceId(),
            }),
            { status: 401, headers: credentialResponseHeaders },
          )
        : HttpServerResponse.jsonUnsafe(
            new EnvironmentInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId: makeTraceId(),
            }),
            { status: 500, headers: credentialResponseHeaders },
          ),
  );

export const authAccessTokenRouteLayer = HttpRouter.add(
  "POST",
  "/oauth/token",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const payload = yield* HttpServerRequest.schemaBodyUrlParams(AuthTokenExchangeRequest).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid OAuth token exchange payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const requestedScopes =
      payload.scope === undefined
        ? undefined
        : parseAllowedOAuthScope({
            value: payload.scope,
            allowedScopes: ALL_AUTH_ENVIRONMENT_SCOPES,
          });
    if (requestedScopes === null) {
      return yield* new AuthError({
        message: "Invalid OAuth scope.",
        status: 400,
        environmentReason: "invalid_scope",
      });
    }
    const result = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
      payload.subject_token,
      requestedScopes,
      deriveAuthClientMetadata({
        request,
        presented: {
          ...(payload.client_label ? { label: payload.client_label } : {}),
          ...(payload.client_device_type ? { deviceType: payload.client_device_type } : {}),
          ...(payload.client_os ? { os: payload.client_os } : {}),
        },
      }),
    );
    return HttpServerResponse.jsonUnsafe(result satisfies AuthAccessTokenResult, {
      status: 200,
      headers: credentialResponseHeaders,
    });
  }).pipe(Effect.catchTag("AuthError", respondToEnvironmentAuthError)),
);

export const authWebSocketTicketRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/websocket-ticket",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const result = yield* serverAuth.issueWebSocketTicket(session);
    return HttpServerResponse.jsonUnsafe(result satisfies AuthWebSocketTicketResult, {
      status: 200,
      headers: credentialResponseHeaders,
    });
  }).pipe(Effect.catchTag("AuthError", respondToEnvironmentAuthError)),
);

export const authWebSocketTokenRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/ws-token",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const result = yield* serverAuth.issueWebSocketToken(session);
    return HttpServerResponse.jsonUnsafe(result satisfies AuthWebSocketTokenResult, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authPairingCredentialRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/pairing-token",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    if (session.role !== "owner") {
      return yield* new AuthError({
        message: "Only owner sessions can create pairing credentials.",
        status: 403,
      });
    }
    yield* requireSessionScope(session.role, AuthAccessWriteScope, session.scopes);
    const headers = yield* HttpServerRequest.schemaHeaders(PairingCredentialRequestHeaders).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid pairing credential request headers.",
            status: 400,
            cause,
          }),
      ),
    );
    const payload = hasRequestBody(headers)
      ? yield* HttpServerRequest.schemaBodyJson(AuthCreatePairingCredentialInput).pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: "Invalid pairing credential payload.",
                status: 400,
                cause,
              }),
          ),
        )
      : {};
    const result = yield* serverAuth.issuePairingCredential(payload);
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

const authenticateOwnerSession = (requiredScope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    if (session.role !== "owner") {
      return yield* new AuthError({
        message: "Only owner sessions can manage network access.",
        status: 403,
      });
    }
    yield* requireSessionScope(session.role, requiredScope, session.scopes);
    return { serverAuth, session } as const;
  });

export const authPairingLinksRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/pairing-links",
  Effect.gen(function* () {
    const { serverAuth } = yield* authenticateOwnerSession(AuthAccessReadScope);
    const pairingLinks = yield* serverAuth.listPairingLinks();
    return HttpServerResponse.jsonUnsafe(pairingLinks, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authPairingLinksRevokeRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/pairing-links/revoke",
  Effect.gen(function* () {
    const { serverAuth } = yield* authenticateOwnerSession(AuthAccessWriteScope);
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthRevokePairingLinkInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid revoke pairing link payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const revoked = yield* serverAuth.revokePairingLink(payload.id);
    return HttpServerResponse.jsonUnsafe({ revoked }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authClientsRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/clients",
  Effect.gen(function* () {
    const { serverAuth, session } = yield* authenticateOwnerSession(AuthAccessReadScope);
    const clients = yield* serverAuth.listClientSessions(session.sessionId);
    return HttpServerResponse.jsonUnsafe(clients, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authClientsRevokeRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/clients/revoke",
  Effect.gen(function* () {
    const { serverAuth, session } = yield* authenticateOwnerSession(AuthAccessWriteScope);
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthRevokeClientSessionInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid revoke client payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const revoked = yield* serverAuth.revokeClientSession(session.sessionId, payload.sessionId);
    return HttpServerResponse.jsonUnsafe({ revoked }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authClientsRevokeOthersRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/clients/revoke-others",
  Effect.gen(function* () {
    const { serverAuth, session } = yield* authenticateOwnerSession(AuthAccessWriteScope);
    const revokedCount = yield* serverAuth.revokeOtherClientSessions(session.sessionId);
    return HttpServerResponse.jsonUnsafe({ revokedCount }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);
