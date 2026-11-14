import type {
  GetIssuingCardholderError,
  GetIssuingCardholderRequest,
  IssuingCardholder as StripeIssuingCardholder,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IssuingCardholder } from "./IssuingCardholder.ts";

export interface RetrieveIssuingCardholderRequest extends Omit<
  GetIssuingCardholderRequest,
  "cardholder"
> {}

/**
 * Retrieve a bound Stripe Issuing Cardholder over HTTP.
 *
 * ### Reading a Cardholder
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveIssuingCardholder(alice);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Issuing
 */
export interface RetrieveIssuingCardholder extends Binding.Service<
  RetrieveIssuingCardholder,
  "Stripe.RetrieveIssuingCardholder",
  (
    cardholder: IssuingCardholder,
  ) => Effect.Effect<
    (
      request?: RetrieveIssuingCardholderRequest,
    ) => Effect.Effect<StripeIssuingCardholder, GetIssuingCardholderError, RuntimeContext>
  >
> {}

export const RetrieveIssuingCardholder = Binding.Service<RetrieveIssuingCardholder>(
  "Stripe.RetrieveIssuingCardholder",
);
