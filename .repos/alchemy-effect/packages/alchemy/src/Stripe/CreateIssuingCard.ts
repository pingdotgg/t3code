import type {
  IssuingCard as StripeIssuingCard,
  CreateIssuingCardError,
  CreateIssuingCardRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * Create a Stripe Issuing Card over HTTP. Account-scoped — binds the API
 * key onto the host, not a specific card resource.
 *
 * ### Creating a Card at runtime
 * **Example:** Bind and create
 * ```typescript
 * const create = yield* Stripe.CreateIssuingCard();
 * const card = yield* create({
 *   cardholder: cardholder.id,
 *   currency: "usd",
 *   type: "virtual",
 * });
 * ```
 *
 * @binding
 */
export interface CreateIssuingCard extends Binding.Service<
  CreateIssuingCard,
  "Stripe.CreateIssuingCard",
  () => Effect.Effect<
    (
      request: CreateIssuingCardRequest,
    ) => Effect.Effect<
      StripeIssuingCard,
      CreateIssuingCardError,
      RuntimeContext
    >
  >
> {}

export const CreateIssuingCard = Binding.Service<CreateIssuingCard>(
  "Stripe.CreateIssuingCard",
);
