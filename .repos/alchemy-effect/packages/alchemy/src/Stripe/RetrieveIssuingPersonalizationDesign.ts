import type {
  GetIssuingPersonalizationDesignError,
  GetIssuingPersonalizationDesignRequest,
  IssuingPersonalizationDesign as StripeIssuingPersonalizationDesign,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
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
