import { Payments } from "@bank/domain/Settlement/Payments.external";
import * as Effect from "effect/Effect";

/**
 * A stand-in adapter for a payment processor. Swap it for a Stripe HTTP
 * adapter in production.
 */
export const StripePayments = Payments.toLayer(
  Effect.succeed({
    refund: ({ settlementId }) => Effect.succeed({ refundId: `re_${settlementId}` }),
  }),
);
