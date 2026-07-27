import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface TranslateKeyMaterialRequest
  extends paymentcryptographydata.TranslateKeyMaterialInput {}

/**
 * Runtime binding for `payment-cryptography:TranslateKeyMaterial` —
 * translates an ECDH-derived TR-31 wrapped key block into a TR-31 key block
 * wrapped under a Key Encryption Key, without importing the short-lived key
 * into the service. The key identifiers live in nested request structures
 * (`IncomingKeyMaterial.DiffieHellmanTr31KeyBlock.PrivateKeyIdentifier`,
 * `OutgoingKeyMaterial.Tr31KeyBlock.WrappingKeyIdentifier`), so the caller
 * supplies the full request; bind every {@link Key} the request references
 * so the Function is granted the action on each. Provide
 * `TranslateKeyMaterialHttp` on the Function to satisfy this service.
 * @binding
 * @section Key Material Translation
 * @example Translate an ECDH-wrapped key to a KEK-wrapped TR-31 block
 * ```typescript
 * // init — grant on every key the request references
 * const translateKeyMaterial =
 *   yield* PaymentCryptography.TranslateKeyMaterial(ecdhPrivateKey, caKey, kek);
 * const ecdhPrivateKeyArn = yield* ecdhPrivateKey.keyArn;
 * const caKeyArn = yield* caKey.keyArn;
 * const kekArn = yield* kek.keyArn;
 *
 * // runtime
 * const translated = yield* translateKeyMaterial({
 *   IncomingKeyMaterial: {
 *     DiffieHellmanTr31KeyBlock: {
 *       PrivateKeyIdentifier: yield* ecdhPrivateKeyArn,
 *       CertificateAuthorityPublicKeyIdentifier: yield* caKeyArn,
 *       // ...
 *     },
 *   },
 *   OutgoingKeyMaterial: { Tr31KeyBlock: { WrappingKeyIdentifier: yield* kekArn } },
 * });
 * ```
 */
export interface TranslateKeyMaterial extends Binding.Service<
  TranslateKeyMaterial,
  "AWS.PaymentCryptography.TranslateKeyMaterial",
  (
    ...keys: readonly [Key, ...Key[]]
  ) => Effect.Effect<
    (
      request: TranslateKeyMaterialRequest,
    ) => Effect.Effect<
      paymentcryptographydata.TranslateKeyMaterialOutput,
      paymentcryptographydata.TranslateKeyMaterialError
    >
  >
> {}

export const TranslateKeyMaterial = Binding.Service<TranslateKeyMaterial>(
  "AWS.PaymentCryptography.TranslateKeyMaterial",
);
