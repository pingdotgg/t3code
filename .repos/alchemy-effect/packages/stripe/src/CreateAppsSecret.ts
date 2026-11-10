import type {
  AppsSecret as StripeAppsSecret,
  CreateAppsSecretError,
  CreateAppsSecretRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Create or replace a Stripe Apps Secret over HTTP. Account-scoped —
 * binds the API key onto the host, not a specific secret resource.
 *
 * ### Creating a Secret at runtime
 * **Example:** Bind and create
 * ```typescript
 * const create = yield* Stripe.CreateAppsSecret();
 * const secret = yield* create({
 *   name: "third-party-api",
 *   payload: "sk_live_example",
 *   scope: { type: "account" },
 * });
 * ```
 *
 * @binding
 * @product Secrets
 */
export interface CreateAppsSecret extends Binding.Service<
  CreateAppsSecret,
  "Stripe.CreateAppsSecret",
  () => Effect.Effect<
    (
      request: CreateAppsSecretRequest,
    ) => Effect.Effect<StripeAppsSecret, CreateAppsSecretError, RuntimeContext>
  >
> {}

export const CreateAppsSecret = Binding.Service<CreateAppsSecret>("Stripe.CreateAppsSecret");
