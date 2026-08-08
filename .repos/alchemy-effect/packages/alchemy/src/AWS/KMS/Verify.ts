import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface VerifyRequest extends Omit<kms.VerifyRequest, "KeyId"> {}

/**
 * Runtime binding for `kms:Verify`.
 *
 * Bind this operation to an asymmetric SIGN_VERIFY KMS {@link Key} (or the
 * `alias/...` name of a pre-existing key) to get a callable that
 * automatically injects the `KeyId`. Verifying inside KMS (rather than with
 * a downloaded public key) means the result is authorized and auditable by
 * IAM/CloudTrail.
 *
 * A mismatched signature surfaces as the typed
 * `KMSInvalidSignatureException` — a valid signature returns
 * `SignatureValid: true`.
 *
 * @binding
 * @section Signing
 * @example Verify a Signature
 * ```typescript
 * const verify = yield* AWS.KMS.Verify(signingKey);
 *
 * const { SignatureValid } = yield* verify({
 *   Message: new TextEncoder().encode("release-manifest-v1"),
 *   Signature: signature,
 *   SigningAlgorithm: "ECDSA_SHA_256",
 * });
 * ```
 *
 * @example Treat a Bad Signature as a Value
 * ```typescript
 * const valid = yield* verify({ Message, Signature, SigningAlgorithm }).pipe(
 *   Effect.map(() => true),
 *   Effect.catchTag("KMSInvalidSignatureException", () =>
 *     Effect.succeed(false),
 *   ),
 * );
 * ```
 */
export interface Verify extends Binding.Service<
  Verify,
  "AWS.KMS.Verify",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request: VerifyRequest,
    ) => Effect.Effect<kms.VerifyResponse, kms.VerifyError>
  >
> {}

export const Verify = Binding.Service<Verify>("AWS.KMS.Verify");
