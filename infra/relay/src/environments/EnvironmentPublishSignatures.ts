import {
  RelayAgentActivityPublishProofPayload,
  type RelayAgentActivityPublishRequest,
} from "@t3tools/contracts/relay";
import {
  decodeRelayJwt,
  normalizeRelayIssuer,
  RELAY_ACTIVITY_PUBLISH_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";

export class EnvironmentPublishSignatureExpired extends Schema.TaggedErrorClass<EnvironmentPublishSignatureExpired>()(
  "EnvironmentPublishSignatureExpired",
  {
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `Environment publish signature expired at ${this.expiresAt}`;
  }
}

export class EnvironmentPublishSignatureInvalid extends Schema.TaggedErrorClass<EnvironmentPublishSignatureInvalid>()(
  "EnvironmentPublishSignatureInvalid",
  {
    environmentId: Schema.String,
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' publish signature is invalid`;
  }
}

export class EnvironmentPublishPublicKeyMissing extends Schema.TaggedErrorClass<EnvironmentPublishPublicKeyMissing>()(
  "EnvironmentPublishPublicKeyMissing",
  {
    environmentId: Schema.String,
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' has no publish public key`;
  }
}

export type EnvironmentPublishSignatureError =
  | EnvironmentPublishSignatureExpired
  | EnvironmentPublishSignatureInvalid
  | EnvironmentPublishPublicKeyMissing
  | DpopProofs.DpopProofReplayPersistenceError;

export class EnvironmentPublishSignatures extends Context.Service<
  EnvironmentPublishSignatures,
  {
    readonly verify: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly threadId: string;
      readonly request: RelayAgentActivityPublishRequest;
    }) => Effect.Effect<void, EnvironmentPublishSignatureError>;
  }
>()("t3code-relay/environments/EnvironmentPublishSignatures") {}

const decodeProof = Schema.decodeUnknownEffect(RelayAgentActivityPublishProofPayload);

function environmentPublishReplayThumbprintData(input: {
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}) {
  return new TextEncoder().encode(
    stableStringify({
      environmentId: input.environmentId,
      environmentPublicKey: input.environmentPublicKey,
    }),
  );
}

const formatEnvironmentPublishReplayThumbprint = (digest: Uint8Array) =>
  `env-publish:${Encoding.encodeBase64Url(digest)}`;

const make = Effect.gen(function* () {
  const proofReplay = yield* DpopProofs.DpopProofReplay;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const crypto = yield* Crypto.Crypto;

  return EnvironmentPublishSignatures.of({
    verify: Effect.fn("relay.environment_publish_signatures.verify")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.thread_id": input.threadId,
      });
      const now = yield* DateTime.now;
      const decoded = yield* Effect.try({
        try: () => decodeRelayJwt(input.request.proof),
        catch: () => new EnvironmentPublishSignatureInvalid({ environmentId: input.environmentId }),
      });
      if (
        typeof decoded.exp === "number" &&
        decoded.exp <= Math.floor(now.epochMilliseconds / 1_000)
      ) {
        return yield* new EnvironmentPublishSignatureExpired({
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(decoded.exp * 1_000)),
        });
      }
      const proof = yield* verifyRelayJwt({
        publicKey: input.environmentPublicKey,
        token: input.request.proof,
        typ: RELAY_ACTIVITY_PUBLISH_TYP,
        issuer: `t3-env:${input.environmentId}`,
        audience: normalizeRelayIssuer(config.relayIssuer),
        nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
      }).pipe(
        Effect.flatMap(decodeProof),
        Effect.mapError(
          () => new EnvironmentPublishSignatureInvalid({ environmentId: input.environmentId }),
        ),
      );
      if (
        proof.environmentId !== input.environmentId ||
        proof.threadId !== input.threadId ||
        proof.sub !== input.environmentId ||
        stableStringify(proof.state) !== stableStringify(input.request.state) ||
        (input.request.state !== null &&
          (input.request.state.environmentId !== input.environmentId ||
            input.request.state.threadId !== input.threadId))
      ) {
        return yield* new EnvironmentPublishSignatureInvalid({
          environmentId: input.environmentId,
        });
      }
      const expiresAt = DateTime.make(proof.exp * 1_000);
      if (expiresAt._tag === "None") {
        return yield* new EnvironmentPublishSignatureInvalid({
          environmentId: input.environmentId,
        });
      }
      const thumbprint = yield* crypto
        .digest(
          "SHA-256",
          environmentPublishReplayThumbprintData({
            environmentId: input.environmentId,
            environmentPublicKey: input.environmentPublicKey,
          }),
        )
        .pipe(
          Effect.map(formatEnvironmentPublishReplayThumbprint),
          Effect.mapError(
            () => new EnvironmentPublishSignatureInvalid({ environmentId: input.environmentId }),
          ),
        );
      const consumedNonce = yield* proofReplay.consume({
        thumbprint,
        jti: proof.jti,
        iat: proof.iat,
        expiresAt: expiresAt.value,
      });
      if (!consumedNonce) {
        return yield* new EnvironmentPublishSignatureInvalid({
          environmentId: input.environmentId,
        });
      }
    }),
  });
});

export const layer = Layer.effect(EnvironmentPublishSignatures, make);
