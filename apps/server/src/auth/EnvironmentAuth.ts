import { AuthSessionId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { Context, Data, Effect, Layer, Predicate } from "effect";
import type * as Duration from "effect/Duration";

import { AuthControlPlane } from "./Services/AuthControlPlane.ts";

class ServerAuthFixedMessageError extends Data.Error<{ readonly cause?: unknown }> {
  readonly _tag: string;

  constructor(tag: string, message: string, props: { readonly cause?: unknown }) {
    super({ cause: props.cause });
    this._tag = tag;
    this.message = message;
  }
}

export class ServerAuthLinkedCloudAccountVerificationError extends ServerAuthFixedMessageError {
  constructor(props: { readonly cause?: unknown }) {
    super(
      "ServerAuthLinkedCloudAccountVerificationError",
      "Could not verify the linked cloud account.",
      props,
    );
  }
}

export class ServerAuthLinkedCloudAccountReadError extends ServerAuthFixedMessageError {
  constructor(props: { readonly cause?: unknown }) {
    super(
      "ServerAuthLinkedCloudAccountReadError",
      "Could not read the linked cloud account.",
      props,
    );
  }
}

export class ServerAuthLinkedCloudAccountMissingError extends ServerAuthFixedMessageError {
  constructor(props: { readonly cause?: unknown }) {
    super(
      "ServerAuthLinkedCloudAccountMissingError",
      "Cloud linked user is not installed for this environment.",
      props,
    );
  }
}

export class ServerAuthCloudLinkJwtSigningError extends ServerAuthFixedMessageError {
  constructor(props: { readonly cause?: unknown }) {
    super("ServerAuthCloudLinkJwtSigningError", "Failed to sign cloud link JWT.", props);
  }
}

export class ServerAuthCloudMintPublicKeyMissingError extends ServerAuthFixedMessageError {
  constructor(props: { readonly cause?: unknown }) {
    super(
      "ServerAuthCloudMintPublicKeyMissingError",
      "Cloud mint public key is not installed for this environment.",
      props,
    );
  }
}

export class ServerAuthCloudRelayIssuerMissingError extends ServerAuthFixedMessageError {
  constructor(props: { readonly cause?: unknown }) {
    super(
      "ServerAuthCloudRelayIssuerMissingError",
      "Cloud relay issuer is not installed for this environment.",
      props,
    );
  }
}

export class ServerAuthCloudHealthJwtSigningError extends ServerAuthFixedMessageError {
  constructor(props: { readonly cause?: unknown }) {
    super("ServerAuthCloudHealthJwtSigningError", "Failed to sign cloud health JWT.", props);
  }
}

export class ServerAuthCloudMintJwtSigningError extends ServerAuthFixedMessageError {
  constructor(props: { readonly cause?: unknown }) {
    super("ServerAuthCloudMintJwtSigningError", "Failed to sign cloud mint JWT.", props);
  }
}

export type ServerAuthInternalError =
  | ServerAuthLinkedCloudAccountVerificationError
  | ServerAuthLinkedCloudAccountReadError
  | ServerAuthLinkedCloudAccountMissingError
  | ServerAuthCloudLinkJwtSigningError
  | ServerAuthCloudMintPublicKeyMissingError
  | ServerAuthCloudRelayIssuerMissingError
  | ServerAuthCloudHealthJwtSigningError
  | ServerAuthCloudMintJwtSigningError;

export function isServerAuthInternalError(error: unknown): error is ServerAuthInternalError {
  return (
    Predicate.isTagged(error, "ServerAuthLinkedCloudAccountVerificationError") ||
    Predicate.isTagged(error, "ServerAuthLinkedCloudAccountReadError") ||
    Predicate.isTagged(error, "ServerAuthLinkedCloudAccountMissingError") ||
    Predicate.isTagged(error, "ServerAuthCloudLinkJwtSigningError") ||
    Predicate.isTagged(error, "ServerAuthCloudMintPublicKeyMissingError") ||
    Predicate.isTagged(error, "ServerAuthCloudRelayIssuerMissingError") ||
    Predicate.isTagged(error, "ServerAuthCloudHealthJwtSigningError") ||
    Predicate.isTagged(error, "ServerAuthCloudMintJwtSigningError")
  );
}

export interface EnvironmentAuthShape {
  readonly issueSession: (input: {
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope> | ReadonlyArray<string>;
    readonly subject: string;
    readonly label?: string;
  }) => Effect.Effect<
    {
      readonly sessionId: AuthSessionId;
      readonly token: string;
      readonly expiresAt: { readonly epochMilliseconds: number };
    },
    unknown
  >;
  readonly revokeSession: (sessionId: AuthSessionId) => Effect.Effect<boolean, unknown>;
  readonly createPairingLink: (input: {
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope> | ReadonlyArray<string>;
    readonly subject?: string;
    readonly ttl?: Duration.Duration;
    readonly label?: string;
    readonly proofKeyThumbprint?: string;
  }) => Effect.Effect<
    {
      readonly id: string;
      readonly credential: string;
      readonly expiresAt: { readonly epochMilliseconds: number };
    },
    unknown
  >;
}

export class EnvironmentAuth extends Context.Service<EnvironmentAuth, EnvironmentAuthShape>()(
  "t3/auth/EnvironmentAuth",
) {}

export const layer = Layer.effect(
  EnvironmentAuth,
  Effect.gen(function* () {
    const controlPlane = yield* AuthControlPlane;
    return {
      issueSession: (input) => controlPlane.issueSession(input),
      revokeSession: (sessionId) => controlPlane.revokeSession(sessionId),
      createPairingLink: (input) => controlPlane.createPairingLink(input),
    } satisfies EnvironmentAuthShape;
  }),
);

export const runtimeLayer = layer;
