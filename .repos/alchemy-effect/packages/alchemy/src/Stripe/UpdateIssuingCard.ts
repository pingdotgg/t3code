import type {
  IssuingCard as StripeIssuingCard,
  UpdateIssuingCardError,
  UpdateIssuingCardRequest as DistilledUpdateIssuingCardRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { IssuingCard } from "./IssuingCard.ts";

export interface UpdateIssuingCardRequest extends Omit<
  DistilledUpdateIssuingCardRequest,
  "card"
> {}

/**
 * Update a bound Stripe Issuing Card over HTTP.
 *
 * ### Updating a Card
 * **Example:** Bind and freeze
 * ```typescript
 * const update = yield* Stripe.UpdateIssuingCard(card);
 * const live = yield* update({ status: "inactive" });
 * ```
 *
 * @binding
 */
export interface UpdateIssuingCard extends Binding.Service<
  UpdateIssuingCard,
  "Stripe.UpdateIssuingCard",
  (
    card: IssuingCard,
  ) => Effect.Effect<
    (
      request?: UpdateIssuingCardRequest,
    ) => Effect.Effect<
      StripeIssuingCard,
      UpdateIssuingCardError,
      RuntimeContext
    >
  >
> {}

export const UpdateIssuingCard = Binding.Service<UpdateIssuingCard>(
  "Stripe.UpdateIssuingCard",
);
