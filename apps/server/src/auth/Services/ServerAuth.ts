import type {
  AuthBearerBootstrapResult,
  AuthBootstrapResult,
  AuthClientMetadata,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingLink,
  AuthPairingCredentialResult,
  AuthSessionId,
  AuthSessionState,
  ServerAuthDescriptor,
  ServerAuthSessionMethod,
  AuthWebSocketTokenResult,
} from "@t3tools/contracts";
import { Data, DateTime, ServiceMap } from "effect";
import type { Effect } from "effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type { SessionRole } from "./SessionCredentialService.ts";

export interface AuthenticatedSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly role: SessionRole;
  readonly expiresAt?: DateTime.DateTime;
}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly status?: 400 | 401 | 403 | 500;
  readonly cause?: unknown;
}> {}

export interface ServerAuthShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
  readonly getSessionState: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthSessionState, never>;
  readonly exchangeBootstrapCredential: (
    credential: string,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<
    {
      readonly response: AuthBootstrapResult;
      readonly sessionToken: string;
    },
    AuthError
  >;
  readonly exchangeBootstrapCredentialForBearerSession: (
    credential: string,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<AuthBearerBootstrapResult, AuthError>;
  readonly issuePairingCredential: (
    input?: AuthCreatePairingCredentialInput & {
      readonly role?: SessionRole;
    },
  ) => Effect.Effect<AuthPairingCredentialResult, AuthError>;
  readonly listPairingLinks: () => Effect.Effect<ReadonlyArray<AuthPairingLink>, AuthError>;
  readonly revokePairingLink: (id: string) => Effect.Effect<boolean, AuthError>;
  readonly listClientSessions: (
    currentSessionId: AuthSessionId,
  ) => Effect.Effect<ReadonlyArray<AuthClientSession>, AuthError>;
  readonly revokeClientSession: (
    currentSessionId: AuthSessionId,
    targetSessionId: AuthSessionId,
  ) => Effect.Effect<boolean, AuthError>;
  readonly revokeOtherClientSessions: (
    currentSessionId: AuthSessionId,
  ) => Effect.Effect<number, AuthError>;
  readonly authenticateHttpRequest: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthenticatedSession, AuthError>;
  readonly authenticateWebSocketUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthenticatedSession, AuthError>;
  readonly issueWebSocketToken: (
    session: AuthenticatedSession,
  ) => Effect.Effect<AuthWebSocketTokenResult, AuthError>;
  readonly issueStartupPairingUrl: (baseUrl: string) => Effect.Effect<string, AuthError>;
}

export class ServerAuth extends ServiceMap.Service<ServerAuth, ServerAuthShape>()(
  "t3/auth/Services/ServerAuth",
) {}
