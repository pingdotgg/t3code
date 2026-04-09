import type { AuthPairingLink, ServerAuthBootstrapMethod } from "@t3tools/contracts";
import { Data, DateTime, Duration, ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export type BootstrapCredentialRole = "owner" | "client";

export interface BootstrapGrant {
  readonly method: ServerAuthBootstrapMethod;
  readonly role: BootstrapCredentialRole;
  readonly subject: string;
  readonly label?: string;
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
    readonly subject?: string;
    readonly label?: string;
  }) => Effect.Effect<IssuedBootstrapCredential, BootstrapCredentialError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<AuthPairingLink>,
    BootstrapCredentialError
  >;
  readonly streamChanges: Stream.Stream<BootstrapCredentialChange>;
  readonly revoke: (id: string) => Effect.Effect<boolean, BootstrapCredentialError>;
  readonly consume: (credential: string) => Effect.Effect<BootstrapGrant, BootstrapCredentialError>;
}

export class BootstrapCredentialService extends ServiceMap.Service<
  BootstrapCredentialService,
  BootstrapCredentialServiceShape
>()("t3/auth/Services/BootstrapCredentialService") {}
