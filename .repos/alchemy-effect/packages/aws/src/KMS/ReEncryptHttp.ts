import * as kms from "@distilled.cloud/aws/kms";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { keyLabel, keyPolicyStatement, type KeyLike } from "./KeyBinding.ts";
import { ReEncrypt, type ReEncryptRequest } from "./ReEncrypt.ts";

/**
 * Bespoke (not scaffolded): ReEncrypt spans two keys — `kms:ReEncryptTo` on
 * the destination and `kms:ReEncryptFrom` on the source — and injects
 * `DestinationKeyId` (plus `SourceKeyId` when a source key is bound).
 */
export const ReEncryptHttp = Layer.effect(
  ReEncrypt,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const reEncrypt = yield* AWSBindings.withCredentials(kms.reEncrypt);

    return Effect.fn(function* (destination: KeyLike, source?: KeyLike) {
      const from = source ?? destination;
      const DestinationKeyId =
        typeof destination === "string"
          ? Effect.succeed<string>(destination)
          : yield* destination.keyId;
      const SourceKeyId =
        typeof from === "string" ? Effect.succeed<string>(from) : yield* from.keyId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.KMS.ReEncrypt(${destination}, ${from})`({
          policyStatements:
            source === undefined
              ? [keyPolicyStatement(["kms:ReEncryptFrom", "kms:ReEncryptTo"], destination)]
              : [
                  keyPolicyStatement("kms:ReEncryptTo", destination),
                  keyPolicyStatement("kms:ReEncryptFrom", from),
                ],
        });
      }
      return Effect.fn(`AWS.KMS.ReEncrypt(${keyLabel(destination)})`)(function* (
        request: ReEncryptRequest,
      ) {
        const destinationKeyId = yield* DestinationKeyId;
        // Always pin the source key (AWS best practice for symmetric
        // ciphertexts) — and required for alias-bound IAM, where the
        // `kms:RequestAlias` condition only matches when the alias appears
        // in the request.
        const sourceKeyId = yield* SourceKeyId;
        return yield* reEncrypt({
          ...request,
          SourceKeyId: sourceKeyId,
          DestinationKeyId: destinationKeyId,
        });
      });
    });
  }),
);
