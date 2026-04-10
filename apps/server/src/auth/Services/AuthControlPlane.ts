import type {
  AuthClientMetadata,
  AuthClientSession,
  AuthPairingLink,
  AuthSessionId,
} from "@t3tools/contracts";
import { Data, DateTime, Duration, Effect, Context } from "effect";
import { SessionRole } from "./SessionCredentialService";

export const DEFAULT_SESSION_SUBJECT = "cli-issued-session";

export interface IssuedPairingLink {
  readonly id: string;
  readonly credential: string;
  readonly role: SessionRole;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export interface IssuedBearerSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: "bearer-session-token";
  readonly role: SessionRole;
  readonly subject: string;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.Utc;
}

export class AuthControlPlaneError extends Data.TaggedError("AuthControlPlaneError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface AuthControlPlaneShape {
  readonly createPairingLink: (input?: {
    readonly ttl?: Duration.Duration;
    readonly label?: string;
    readonly role?: SessionRole;
    readonly subject?: string;
  }) => Effect.Effect<IssuedPairingLink, AuthControlPlaneError>;
  readonly listPairingLinks: (input?: {
    readonly role?: SessionRole;
    readonly excludeSubjects?: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<AuthPairingLink>, AuthControlPlaneError>;
  readonly revokePairingLink: (id: string) => Effect.Effect<boolean, AuthControlPlaneError>;
  readonly issueSession: (input?: {
    readonly ttl?: Duration.Duration;
    readonly subject?: string;
    readonly role?: SessionRole;
    readonly label?: string;
  }) => Effect.Effect<IssuedBearerSession, AuthControlPlaneError>;
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<AuthClientSession>,
    AuthControlPlaneError
  >;
  readonly revokeSession: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<boolean, AuthControlPlaneError>;
  readonly revokeOtherSessionsExcept: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<number, AuthControlPlaneError>;
}

export class AuthControlPlane extends Context.Service<AuthControlPlane, AuthControlPlaneShape>()(
  "t3/AuthControlPlane",
) {}
