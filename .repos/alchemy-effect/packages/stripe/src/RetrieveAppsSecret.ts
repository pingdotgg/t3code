import type {
  AppsSecret as StripeAppsSecret,
  GetAppsSecretsFindError,
  GetAppsSecretsFindRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AppsSecret } from "./AppsSecret.ts";

export interface RetrieveAppsSecretRequest extends Omit<
  GetAppsSecretsFindRequest,
  "name" | "scope"
> {}

/**
 * Retrieve a bound Stripe Apps Secret over HTTP. Find is keyed by
 * `name` and `scope`, both taken from the bound resource.
 *
 * ### Reading an Apps Secret
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveAppsSecret(apiKey);
 * const live = yield* retrieve({ expand: ["payload"] });
 * ```
 *
 * @binding
 * @product Secrets
 */
export interface RetrieveAppsSecret extends Binding.Service<
  RetrieveAppsSecret,
  "Stripe.RetrieveAppsSecret",
  (
    secret: AppsSecret,
  ) => Effect.Effect<
    (
      request?: RetrieveAppsSecretRequest,
    ) => Effect.Effect<StripeAppsSecret, GetAppsSecretsFindError, RuntimeContext>
  >
> {}

export const RetrieveAppsSecret = Binding.Service<RetrieveAppsSecret>("Stripe.RetrieveAppsSecret");
