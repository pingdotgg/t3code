import type {
  GetPlanError,
  GetPlanRequest,
  Plan as StripePlan,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Plan } from "./Plan.ts";

export interface RetrievePlanRequest extends Omit<GetPlanRequest, "plan"> {}

/**
 * Retrieve a bound Stripe Plan over HTTP.
 *
 * ### Reading a Plan
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrievePlan(plan);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Product
 */
export interface RetrievePlan extends Binding.Service<
  RetrievePlan,
  "Stripe.RetrievePlan",
  (
    plan: Plan,
  ) => Effect.Effect<
    (request?: RetrievePlanRequest) => Effect.Effect<StripePlan, GetPlanError, RuntimeContext>
  >
> {}

export const RetrievePlan = Binding.Service<RetrievePlan>("Stripe.RetrievePlan");
