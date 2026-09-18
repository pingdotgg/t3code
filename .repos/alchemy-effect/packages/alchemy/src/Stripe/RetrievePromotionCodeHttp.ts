import { GetPromotionCode } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrievePromotionCode } from "./RetrievePromotionCode.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrievePromotionCode}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrievePromotionCode
 */
export const RetrievePromotionCodeHttp = Layer.effect(
  RetrievePromotionCode,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrievePromotionCode",
    operation: GetPromotionCode,
    idField: "promotion_code",
    permissions: ["promotion_codes_read"],
  }),
);
