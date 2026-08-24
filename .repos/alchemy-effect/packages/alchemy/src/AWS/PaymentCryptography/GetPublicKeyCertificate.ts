import type * as paymentcryptography from "@distilled.cloud/aws/payment-cryptography";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

/**
 * Runtime binding for `payment-cryptography:GetPublicKeyCertificate` —
 * exports the public-key certificate (and its root certificate chain) of an
 * asymmetric key pair {@link Key}, e.g. to share the public verification key
 * with a partner. The private key never leaves the service. Provide
 * `GetPublicKeyCertificateHttp` on the Function to satisfy this service.
 * @binding
 * @section Public Key Certificates
 * @example Export the public key certificate of a signing key
 * ```typescript
 * // init
 * const getPublicKeyCertificate =
 *   yield* PaymentCryptography.GetPublicKeyCertificate(signKey);
 *
 * // runtime — both fields are base64-encoded certificates
 * const { KeyCertificate, KeyCertificateChain } =
 *   yield* getPublicKeyCertificate();
 * ```
 */
export interface GetPublicKeyCertificate extends Binding.Service<
  GetPublicKeyCertificate,
  "AWS.PaymentCryptography.GetPublicKeyCertificate",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    () => Effect.Effect<
      paymentcryptography.GetPublicKeyCertificateOutput,
      paymentcryptography.GetPublicKeyCertificateError
    >
  >
> {}

export const GetPublicKeyCertificate = Binding.Service<GetPublicKeyCertificate>(
  "AWS.PaymentCryptography.GetPublicKeyCertificate",
);
