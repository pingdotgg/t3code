import type {
  BillingPortalConfiguration as StripeBillingPortalConfiguration,
  GetBillingPortalConfigurationError,
  GetBillingPortalConfigurationRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BillingPortalConfiguration } from "./BillingPortalConfiguration.ts";

export interface RetrieveBillingPortalConfigurationRequest extends Omit<
  GetBillingPortalConfigurationRequest,
  "configuration"
> {}

/**
 * Retrieve a bound Stripe Billing Portal Configuration over HTTP.
 *
 * ### Reading a Portal Configuration
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveBillingPortalConfiguration(portal);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Billing
 */
export interface RetrieveBillingPortalConfiguration extends Binding.Service<
  RetrieveBillingPortalConfiguration,
  "Stripe.RetrieveBillingPortalConfiguration",
  (
    configuration: BillingPortalConfiguration,
  ) => Effect.Effect<
    (
      request?: RetrieveBillingPortalConfigurationRequest,
    ) => Effect.Effect<
      StripeBillingPortalConfiguration,
      GetBillingPortalConfigurationError,
      RuntimeContext
    >
  >
> {}

export const RetrieveBillingPortalConfiguration =
  Binding.Service<RetrieveBillingPortalConfiguration>("Stripe.RetrieveBillingPortalConfiguration");
