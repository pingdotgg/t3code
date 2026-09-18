import type {
  GetPromotionCodeError,
  GetPromotionCodeRequest,
  PromotionCode as StripePromotionCode,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { PromotionCode } from "./PromotionCode.ts";

export interface RetrievePromotionCodeRequest extends Omit<
  GetPromotionCodeRequest,
  "promotion_code"
> {}

/**
 * Retrieve a bound Stripe Promotion Code over HTTP.
 *
 * ### Reading a Promotion Code
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrievePromotionCode(promo);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrievePromotionCode extends Binding.Service<
  RetrievePromotionCode,
  "Stripe.RetrievePromotionCode",
  (
    promotionCode: PromotionCode,
  ) => Effect.Effect<
    (
      request?: RetrievePromotionCodeRequest,
    ) => Effect.Effect<
      StripePromotionCode,
      GetPromotionCodeError,
      RuntimeContext
    >
  >
> {}

export const RetrievePromotionCode = Binding.Service<RetrievePromotionCode>(
  "Stripe.RetrievePromotionCode",
);
