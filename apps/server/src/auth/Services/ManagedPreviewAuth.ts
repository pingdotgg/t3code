import type {
  AuthPreviewBootstrapInput,
  AuthPreviewBootstrapResult,
  EnvironmentId,
  PreviewAutomationManagedTargetAuth,
  PreviewAutomationOperation,
} from "@t3tools/contracts";
import { Data, Context } from "effect";
import type { Effect } from "effect";

export interface ManagedPreviewAuthRequest {
  readonly environmentId: EnvironmentId;
  readonly providerSessionId: string;
  readonly capabilities: ReadonlySet<string>;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
}

export interface ManagedPreviewAuthGrant {
  readonly payload: PreviewAutomationManagedTargetAuth;
  readonly grantIds: ReadonlyArray<string>;
}

export interface ManagedPreviewBootstrapExchange {
  readonly credential: string;
  readonly encryptResponse: (
    plaintext: string,
  ) => Effect.Effect<AuthPreviewBootstrapResult, ManagedPreviewAuthError>;
}

export class ManagedPreviewAuthError extends Data.TaggedError("ManagedPreviewAuthError")<{
  readonly message: string;
  readonly reason?: "authorization-revoked" | "bootstrap-failed";
  readonly cause?: unknown;
}> {}

export interface ManagedPreviewAuthShape {
  readonly prepare: (
    input: ManagedPreviewAuthRequest,
  ) => Effect.Effect<ManagedPreviewAuthGrant | undefined, ManagedPreviewAuthError>;
  readonly attest: (challenge: string, origin: string) => Effect.Effect<string | undefined>;
  readonly openBootstrap: (
    input: AuthPreviewBootstrapInput,
  ) => Effect.Effect<ManagedPreviewBootstrapExchange, ManagedPreviewAuthError>;
  readonly release: (
    grant: ManagedPreviewAuthGrant,
  ) => Effect.Effect<void, ManagedPreviewAuthError>;
  readonly revokeProviderSession: (
    providerSessionId: string,
  ) => Effect.Effect<void, ManagedPreviewAuthError>;
  readonly revokeAll: Effect.Effect<void, ManagedPreviewAuthError>;
}

export class ManagedPreviewAuth extends Context.Service<
  ManagedPreviewAuth,
  ManagedPreviewAuthShape
>()("t3/auth/Services/ManagedPreviewAuth") {}
