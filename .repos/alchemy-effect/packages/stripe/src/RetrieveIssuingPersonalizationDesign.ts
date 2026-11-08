import type {
  GetIssuingPersonalizationDesignError,
  GetIssuingPersonalizationDesignRequest,
  IssuingPersonalizationDesign as StripeIssuingPersonalizationDesign,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IssuingPersonalizationDesign } from "./IssuingPersonalizationDesign.ts";

export interface RetrieveIssuingPersonalizationDesignRequest extends Omit<
  GetIssuingPersonalizationDesignRequest,
  "personalization_design"
> {}

/**
 * Retrieve a bound Stripe Issuing Personalization Design over HTTP.
 *
 * ### Reading a Personalization Design
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveIssuingPersonalizationDesign(design);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Issuing
 */
export interface RetrieveIssuingPersonalizationDesign extends Binding.Service<
  RetrieveIssuingPersonalizationDesign,
  "Stripe.RetrieveIssuingPersonalizationDesign",
  (
    design: IssuingPersonalizationDesign,
  ) => Effect.Effect<
    (
      request?: RetrieveIssuingPersonalizationDesignRequest,
    ) => Effect.Effect<
      StripeIssuingPersonalizationDesign,
      GetIssuingPersonalizationDesignError,
      RuntimeContext
    >
  >
> {}

export const RetrieveIssuingPersonalizationDesign =
  Binding.Service<RetrieveIssuingPersonalizationDesign>(
    "Stripe.RetrieveIssuingPersonalizationDesign",
  );
