import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import { DecryptData } from "./DecryptData.ts";

/**
 * HTTP implementation of {@link DecryptData} — grants the host Function
 * `payment-cryptography:DecryptData` on the key and calls the
 * Payment Cryptography Data API at runtime.
 * @example Provide on a Lambda Function
 * ```typescript
 * Effect.gen(function* () {
 *   const key = yield* PaymentCryptography.Key("DataKey", { ... });
 *   const decrypt = yield* PaymentCryptography.DecryptData(key);
 *
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const decrypted = yield* decrypt({
 *         CipherText: cipherTextHex,
 *         DecryptionAttributes: {
 *           Symmetric: { Mode: "CBC", InitializationVector: iv },
 *         },
 *       });
 *       // ...
 *     }),
 *   };
 * }).pipe(Effect.provide(PaymentCryptography.DecryptDataHttp))
 * ```
 */
export const DecryptDataHttp = Layer.effect(
  DecryptData,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.DecryptData",
    operation: paymentcryptographydata.decryptData,
    actions: ["payment-cryptography:DecryptData"],
  }),
);
