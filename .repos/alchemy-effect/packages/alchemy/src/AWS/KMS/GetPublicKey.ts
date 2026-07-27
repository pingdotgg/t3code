import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface GetPublicKeyRequest extends Omit<
  kms.GetPublicKeyRequest,
  "KeyId"
> {}

/**
 * Runtime binding for `kms:GetPublicKey`.
 *
 * Bind this operation to an asymmetric KMS {@link Key} (or the `alias/...`
 * name of a pre-existing key) to get a callable that automatically injects
 * the `KeyId`. Returns the DER-encoded public key so callers can verify
 * signatures or encrypt locally without a KMS round-trip per operation.
 *
 * @binding
 * @section Signing
 * @example Download the Public Key
 * ```typescript
 * const getPublicKey = yield* AWS.KMS.GetPublicKey(signingKey);
 *
 * const { PublicKey, SigningAlgorithms } = yield* getPublicKey({});
 * // PublicKey is the DER-encoded SubjectPublicKeyInfo
 * ```
 */
export interface GetPublicKey extends Binding.Service<
  GetPublicKey,
  "AWS.KMS.GetPublicKey",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request?: GetPublicKeyRequest,
    ) => Effect.Effect<kms.GetPublicKeyResponse, kms.GetPublicKeyError>
  >
> {}

export const GetPublicKey = Binding.Service<GetPublicKey>(
  "AWS.KMS.GetPublicKey",
);
