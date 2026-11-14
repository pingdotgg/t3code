import type {
  EntitlementsFeature as StripeEntitlementsFeature,
  GetEntitlementsFeatureError,
  GetEntitlementsFeatureRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { EntitlementsFeature } from "./EntitlementsFeature.ts";

export interface RetrieveEntitlementsFeatureRequest extends Omit<
  GetEntitlementsFeatureRequest,
  "id"
> {}

/**
 * Retrieve a bound Stripe Entitlements Feature over HTTP.
 *
 * ### Reading a Feature
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveEntitlementsFeature(seats);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Entitlements
 */
export interface RetrieveEntitlementsFeature extends Binding.Service<
  RetrieveEntitlementsFeature,
  "Stripe.RetrieveEntitlementsFeature",
  (
    feature: EntitlementsFeature,
  ) => Effect.Effect<
    (
      request?: RetrieveEntitlementsFeatureRequest,
    ) => Effect.Effect<StripeEntitlementsFeature, GetEntitlementsFeatureError, RuntimeContext>
  >
> {}

export const RetrieveEntitlementsFeature = Binding.Service<RetrieveEntitlementsFeature>(
  "Stripe.RetrieveEntitlementsFeature",
);
