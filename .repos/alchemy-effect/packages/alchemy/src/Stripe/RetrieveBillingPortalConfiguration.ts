import type {
  BillingPortalConfiguration as StripeBillingPortalConfiguration,
  GetBillingPortalConfigurationError,
  GetBillingPortalConfigurationRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
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
  Binding.Service<RetrieveBillingPortalConfiguration>(
    "Stripe.RetrieveBillingPortalConfiguration",
  );
