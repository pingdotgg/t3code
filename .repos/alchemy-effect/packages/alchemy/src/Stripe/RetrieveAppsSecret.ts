import type {
  AppsSecret as StripeAppsSecret,
  GetAppsSecretsFindError,
  GetAppsSecretsFindRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
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
 */
export interface RetrieveAppsSecret extends Binding.Service<
  RetrieveAppsSecret,
  "Stripe.RetrieveAppsSecret",
  (
    secret: AppsSecret,
  ) => Effect.Effect<
    (
      request?: RetrieveAppsSecretRequest,
    ) => Effect.Effect<
      StripeAppsSecret,
      GetAppsSecretsFindError,
      RuntimeContext
    >
  >
> {}

export const RetrieveAppsSecret = Binding.Service<RetrieveAppsSecret>(
  "Stripe.RetrieveAppsSecret",
);
