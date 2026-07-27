import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import { GenerateMac } from "./GenerateMac.ts";

/**
 * HTTP implementation of {@link GenerateMac} — grants the host Function
 * `payment-cryptography:GenerateMac` on the key and calls the
 * Payment Cryptography Data API at runtime.
 * @example Provide on a Lambda Function
 * ```typescript
 * Effect.gen(function* () {
 *   const macKey = yield* PaymentCryptography.Key("MacKey", {
 *     keyAttributes: {
 *       keyAlgorithm: "HMAC_SHA256",
 *       keyClass: "SYMMETRIC_KEY",
 *       keyUsage: "TR31_M7_HMAC_KEY",
 *       keyModesOfUse: { generate: true, verify: true },
 *     },
 *   });
 *   const generateMac = yield* PaymentCryptography.GenerateMac(macKey);
 *
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const generated = yield* generateMac({
 *         MessageData: messageDataHex,
 *         GenerationAttributes: { Algorithm: "HMAC" },
 *       });
 *       // ...
 *     }),
 *   };
 * }).pipe(Effect.provide(PaymentCryptography.GenerateMacHttp))
 * ```
 */
export const GenerateMacHttp = Layer.effect(
  GenerateMac,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.GenerateMac",
    operation: paymentcryptographydata.generateMac,
    actions: ["payment-cryptography:GenerateMac"],
  }),
);
