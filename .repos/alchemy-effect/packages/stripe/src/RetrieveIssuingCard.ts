import type {
  GetIssuingCardError,
  GetIssuingCardRequest,
  IssuingCard as StripeIssuingCard,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IssuingCard } from "./IssuingCard.ts";

export interface RetrieveIssuingCardRequest extends Omit<GetIssuingCardRequest, "card"> {}

/**
 * Retrieve a bound Stripe Issuing Card over HTTP.
 *
 * ### Reading a Card
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveIssuingCard(card);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Issuing
 */
export interface RetrieveIssuingCard extends Binding.Service<
  RetrieveIssuingCard,
  "Stripe.RetrieveIssuingCard",
  (
    card: IssuingCard,
  ) => Effect.Effect<
    (
      request?: RetrieveIssuingCardRequest,
    ) => Effect.Effect<StripeIssuingCard, GetIssuingCardError, RuntimeContext>
  >
> {}

export const RetrieveIssuingCard = Binding.Service<RetrieveIssuingCard>(
  "Stripe.RetrieveIssuingCard",
);
