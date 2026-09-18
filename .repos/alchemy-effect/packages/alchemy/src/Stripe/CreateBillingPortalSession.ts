import type {
  BillingPortalSession,
  CreateBillingPortalSessionError,
  CreateBillingPortalSessionRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * Create a Stripe Billing Portal Session over HTTP. The portal is
 * Stripe's hosted page where a customer updates their card, switches
 * plans, downloads invoices, or cancels — so your app never has to build
 * those screens. Create the session for the customer and redirect them to
 * `session.url`.
 *
 * Account-scoped — binds the API key onto the host, not a specific
 * resource.
 *
 * ### Letting a customer manage their subscription
 * **Example:** Open the hosted portal
 * ```typescript
 * const createPortal = yield* Stripe.CreateBillingPortalSession();
 *
 * // inside a Worker route
 * const session = yield* createPortal({
 *   customer: customerId,
 *   return_url: `${origin}/account`,
 * });
 * // redirect to session.url
 * ```
 *
 * @binding
 */
export interface CreateBillingPortalSession extends Binding.Service<
  CreateBillingPortalSession,
  "Stripe.CreateBillingPortalSession",
  () => Effect.Effect<
    (
      request: CreateBillingPortalSessionRequest,
    ) => Effect.Effect<
      BillingPortalSession,
      CreateBillingPortalSessionError,
      RuntimeContext
    >
  >
> {}

export const CreateBillingPortalSession =
  Binding.Service<CreateBillingPortalSession>(
    "Stripe.CreateBillingPortalSession",
  );
