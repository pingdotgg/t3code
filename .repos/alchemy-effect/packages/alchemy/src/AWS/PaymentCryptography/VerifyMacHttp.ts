import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import { VerifyMac } from "./VerifyMac.ts";

/**
 * HTTP implementation of {@link VerifyMac} — grants the host Function
 * `payment-cryptography:VerifyMac` on the key and calls the
 * Payment Cryptography Data API at runtime. A MAC mismatch fails with the
 * typed `VerificationFailedException`.
 * @example Provide on a Lambda Function
 * ```typescript
 * Effect.gen(function* () {
 *   const macKey = yield* PaymentCryptography.Key("MacKey", { ... });
 *   const verifyMac = yield* PaymentCryptography.VerifyMac(macKey);
 *
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const result = yield* verifyMac({
 *         MessageData: messageDataHex,
 *         Mac: mac,
 *         VerificationAttributes: { Algorithm: "HMAC" },
 *       }).pipe(
 *         Effect.map(() => "verified"),
 *         Effect.catchTag("VerificationFailedException", () =>
 *           Effect.succeed("verification-failed"),
 *         ),
 *       );
 *       // ...
 *     }),
 *   };
 * }).pipe(Effect.provide(PaymentCryptography.VerifyMacHttp))
 * ```
 */
export const VerifyMacHttp = Layer.effect(
  VerifyMac,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.VerifyMac",
    operation: paymentcryptographydata.verifyMac,
    actions: ["payment-cryptography:VerifyMac"],
  }),
);
