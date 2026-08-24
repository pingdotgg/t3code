import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface SignRequest extends Omit<kms.SignRequest, "KeyId"> {}

/**
 * Runtime binding for `kms:Sign`.
 *
 * Bind this operation to an asymmetric SIGN_VERIFY KMS {@link Key} (or the
 * `alias/...` name of a pre-existing key) to get a callable that
 * automatically injects the `KeyId`. The private key never leaves KMS — the
 * signature is produced inside the HSM.
 *
 * @binding
 * @section Signing
 * @example Sign a Message
 * ```typescript
 * const sign = yield* AWS.KMS.Sign(signingKey);
 *
 * const { Signature } = yield* sign({
 *   Message: new TextEncoder().encode("release-manifest-v1"),
 *   SigningAlgorithm: "ECDSA_SHA_256",
 * });
 * ```
 *
 * @example Sign a Pre-Computed Digest
 * ```typescript
 * // For payloads larger than 4096 bytes, hash locally and sign the digest.
 * const { Signature } = yield* sign({
 *   Message: sha256Digest,
 *   MessageType: "DIGEST",
 *   SigningAlgorithm: "ECDSA_SHA_256",
 * });
 * ```
 */
export interface Sign extends Binding.Service<
  Sign,
  "AWS.KMS.Sign",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (request: SignRequest) => Effect.Effect<kms.SignResponse, kms.SignError>
  >
> {}

export const Sign = Binding.Service<Sign>("AWS.KMS.Sign");
