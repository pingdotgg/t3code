import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface DeriveSharedSecretRequest extends Omit<
  kms.DeriveSharedSecretRequest,
  "KeyId"
> {}

/**
 * Runtime binding for `kms:DeriveSharedSecret`.
 *
 * Bind this operation to a KEY_AGREEMENT KMS {@link Key} (or the `alias/...`
 * name of a pre-existing key) to get a callable that automatically injects
 * the `KeyId`. Runs ECDH between the bound key's private key (inside KMS)
 * and a peer's public key, returning the raw shared secret for use with a
 * key-derivation function.
 *
 * The `SharedSecret` in the response is wrapped in `Redacted` so it never
 * leaks into logs — unwrap with `Redacted.value(...)` at the point of use.
 *
 * @binding
 * @section Key Agreement
 * @example Derive a Shared Secret
 * ```typescript
 * const deriveSharedSecret = yield* AWS.KMS.DeriveSharedSecret(agreementKey);
 *
 * const { SharedSecret } = yield* deriveSharedSecret({
 *   KeyAgreementAlgorithm: "ECDH",
 *   PublicKey: peerPublicKeyDer, // DER-encoded SubjectPublicKeyInfo
 * });
 * ```
 */
export interface DeriveSharedSecret extends Binding.Service<
  DeriveSharedSecret,
  "AWS.KMS.DeriveSharedSecret",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request: DeriveSharedSecretRequest,
    ) => Effect.Effect<
      kms.DeriveSharedSecretResponse,
      kms.DeriveSharedSecretError
    >
  >
> {}

export const DeriveSharedSecret = Binding.Service<DeriveSharedSecret>(
  "AWS.KMS.DeriveSharedSecret",
);
