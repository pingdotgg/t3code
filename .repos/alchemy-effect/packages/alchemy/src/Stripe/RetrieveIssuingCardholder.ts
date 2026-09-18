import type {
  GetIssuingCardholderError,
  GetIssuingCardholderRequest,
  IssuingCardholder as StripeIssuingCardholder,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
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
 */
export interface RetrieveIssuingCardholder extends Binding.Service<
  RetrieveIssuingCardholder,
  "Stripe.RetrieveIssuingCardholder",
  (
    cardholder: IssuingCardholder,
  ) => Effect.Effect<
    (
      request?: RetrieveIssuingCardholderRequest,
    ) => Effect.Effect<
      StripeIssuingCardholder,
      GetIssuingCardholderError,
      RuntimeContext
    >
  >
> {}

export const RetrieveIssuingCardholder =
  Binding.Service<RetrieveIssuingCardholder>(
    "Stripe.RetrieveIssuingCardholder",
  );
