import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import { GenerateAs2805KekValidation } from "./GenerateAs2805KekValidation.ts";

/**
 * HTTP implementation of {@link GenerateAs2805KekValidation} — grants the
 * host Function `payment-cryptography:GenerateAs2805KekValidation` on the
 * KEK and calls the Payment Cryptography Data API at runtime.
 */
export const GenerateAs2805KekValidationHttp = Layer.effect(
  GenerateAs2805KekValidation,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.GenerateAs2805KekValidation",
    operation: paymentcryptographydata.generateAs2805KekValidation,
    actions: ["payment-cryptography:GenerateAs2805KekValidation"],
  }),
);
