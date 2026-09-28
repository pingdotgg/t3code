import {
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type ServerAuthBootstrapMethod,
} from "@t3tools/contracts";
import { Data, DateTime, Duration, Context } from "effect";
import type { Effect, Stream } from "effect";

export type BootstrapCredentialRole = "owner" | "client";

export interface BootstrapGrant {
  readonly method: ServerAuthBootstrapMethod;
  readonly role: BootstrapCredentialRole;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly proofKeyThumbprint?: string;
  readonly browserSessionOnly?: boolean;
  readonly expiresAt: DateTime.DateTime;
}

export class BootstrapCredentialError extends Data.TaggedError("BootstrapCredentialError")<{
  readonly message: string;
  readonly status?: 401 | 500;
  readonly cause?: unknown;
}> {}

export interface IssuedBootstrapCredential {
  readonly id: string;
  readonly credential: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label?: string;
  readonly expiresAt: DateTime.Utc;
}

export type BootstrapCredentialChange =
  | {
      readonly type: "pairingLinkUpserted";
      readonly pairingLink: AuthPairingLink;
    }
  | {
      readonly type: "pairingLinkRemoved";
      readonly id: string;
    };

export interface BootstrapCredentialServiceShape {
  readonly issueOneTimeToken: (input?: {
    readonly ttl?: Duration.Duration;
    readonly role?: BootstrapCredentialRole;
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly subject?: string;
    readonly label?: string;
    readonly proofKeyThumbprint?: string;
  }) => Effect.Effect<IssuedBootstrapCredential, BootstrapCredentialError>;
  readonly issueTransientBrowserSessionToken: (input: {
    readonly ttl: Duration.Duration;
    readonly subject: string;
    readonly label?: string;
  }) => Effect.Effect<IssuedBootstrapCredential, BootstrapCredentialError>;
  readonly revokeTransientOneTimeToken: (id: string) => Effect.Effect<boolean>;
  readonly revokeTransientOneTimeTokensForSubject: (subject: string) => Effect.Effect<number>;
  readonly isTransientSubjectRevoked: (subject: string) => Effect.Effect<boolean>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<AuthPairingLink>,
    BootstrapCredentialError
  >;
  readonly streamChanges: Stream.Stream<BootstrapCredentialChange>;
  readonly revoke: (id: string) => Effect.Effect<boolean, BootstrapCredentialError>;
  readonly consume: (
    credential: string,
    proofKeyThumbprint?: string,
  ) => Effect.Effect<BootstrapGrant, BootstrapCredentialError>;
}

export class BootstrapCredentialService extends Context.Service<
  BootstrapCredentialService,
  BootstrapCredentialServiceShape
>()("t3/auth/Services/BootstrapCredentialService") {}
