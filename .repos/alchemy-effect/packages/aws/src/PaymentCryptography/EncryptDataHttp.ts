import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import { EncryptData } from "./EncryptData.ts";

/**
 * HTTP implementation of {@link EncryptData} — grants the host Function
 * `payment-cryptography:EncryptData` on the key and calls the
 * Payment Cryptography Data API at runtime.
 * @example Provide on a Lambda Function
 * ```typescript
 * Effect.gen(function* () {
 *   const key = yield* PaymentCryptography.Key("DataKey", { ... });
 *   const encrypt = yield* PaymentCryptography.EncryptData(key);
 *
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const encrypted = yield* encrypt({
 *         PlainText: plainTextHex,
 *         EncryptionAttributes: {
 *           Symmetric: { Mode: "CBC", InitializationVector: iv },
 *         },
 *       });
 *       // ...
 *     }),
 *   };
 * }).pipe(Effect.provide(PaymentCryptography.EncryptDataHttp))
 * ```
 */
export const EncryptDataHttp = Layer.effect(
  EncryptData,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.EncryptData",
    operation: paymentcryptographydata.encryptData,
    actions: ["payment-cryptography:EncryptData"],
  }),
);
