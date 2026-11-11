import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import { GenerateAuthRequestCryptogram } from "./GenerateAuthRequestCryptogram.ts";

/**
 * HTTP implementation of {@link GenerateAuthRequestCryptogram} — grants the
 * host Function `payment-cryptography:GenerateAuthRequestCryptogram` on the
 * issuer master key and calls the Payment Cryptography Data API at runtime.
 */
export const GenerateAuthRequestCryptogramHttp = Layer.effect(
  GenerateAuthRequestCryptogram,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.GenerateAuthRequestCryptogram",
    operation: paymentcryptographydata.generateAuthRequestCryptogram,
    actions: ["payment-cryptography:GenerateAuthRequestCryptogram"],
  }),
);
