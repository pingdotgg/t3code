import { FEDERATION_AUTH_JWT_TYP, type EnvironmentId } from "@t3tools/contracts";
import { signRelayJwt, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

/**
 * The environment's federation identity is its existing Ed25519 key pair from
 * the secret store (also used for T3 Connect link proofs). Reusing it keeps one
 * stable cryptographic identity per environment instead of a second key system.
 */
export const FEDERATION_ASSERTION_MAX_AGE_SECONDS = 120;

export class FederationIdentity extends Context.Service<
  FederationIdentity,
  {
    readonly environmentId: EnvironmentId;
    /** SPKI PEM. Safe to share; it is what peers pin. */
    readonly publicKey: string;
    readonly fingerprint: string;
    /** Signs a challenge for `audience`, proving control of this environment's key. */
    readonly signChallenge: (input: {
      readonly audience: EnvironmentId;
      readonly challenge: string;
    }) => Effect.Effect<string, FederationIdentitySignError>;
    /**
     * Verifies a peer's signed assertion against the public key pinned for it
     * and returns the challenge it answers, for the caller to match against
     * the challenges it issued.
     */
    readonly verifyChallenge: (input: {
      readonly assertion: string;
      readonly issuer: EnvironmentId;
      readonly publicKey: string;
    }) => Effect.Effect<string, FederationIdentityVerifyError>;
  }
>()("t3/federation/FederationIdentity") {}

export class FederationIdentitySignError extends Schema.TaggedErrorClass<FederationIdentitySignError>()(
  "FederationIdentitySignError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not sign the federation challenge.";
  }
}

export class FederationIdentityVerifyError extends Schema.TaggedErrorClass<FederationIdentityVerifyError>()(
  "FederationIdentityVerifyError",
  {
    reason: Schema.Literals(["signature", "challenge"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "challenge"
      ? "The federation assertion does not answer the issued challenge."
      : "The federation assertion signature is invalid.";
  }
}

export function federationKeyFingerprint(publicKeyPem: string): string {
  const normalized = publicKeyPem.replace(/\\n/gu, "\n").trim();
  const hex = NodeCrypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${hex.slice(0, 4)}·${hex.slice(4, 8)}·${hex.slice(8, 12)}·${hex.slice(12, 16)}`;
}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);

  const signChallenge: FederationIdentity["Service"]["signChallenge"] = ({ audience, challenge }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) => {
        const iat = Math.floor(DateTime.toEpochMillis(now) / 1000);
        return signRelayJwt({
          privateKey: keyPair.privateKey,
          typ: FEDERATION_AUTH_JWT_TYP,
          payload: {
            iss: environmentId,
            aud: audience,
            jti: challenge,
            iat,
            exp: iat + FEDERATION_ASSERTION_MAX_AGE_SECONDS,
          },
        });
      }),
      Effect.mapError((cause) => new FederationIdentitySignError({ cause })),
    );

  const verifyChallenge: FederationIdentity["Service"]["verifyChallenge"] = (input) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        verifyRelayJwt({
          publicKey: input.publicKey,
          token: input.assertion,
          typ: FEDERATION_AUTH_JWT_TYP,
          issuer: input.issuer,
          audience: environmentId,
          nowEpochSeconds: Math.floor(DateTime.toEpochMillis(now) / 1000),
          maxTokenAge: `${FEDERATION_ASSERTION_MAX_AGE_SECONDS} seconds`,
        }),
      ),
      Effect.mapError((cause) => new FederationIdentityVerifyError({ reason: "signature", cause })),
      Effect.flatMap((payload) =>
        typeof payload.jti === "string" && payload.jti.length > 0
          ? Effect.succeed(payload.jti)
          : Effect.fail(new FederationIdentityVerifyError({ reason: "challenge" })),
      ),
    );

  return FederationIdentity.of({
    environmentId,
    publicKey: keyPair.publicKey,
    fingerprint: federationKeyFingerprint(keyPair.publicKey),
    signChallenge,
    verifyChallenge,
  });
});

export const layer = Layer.effect(FederationIdentity, make);
