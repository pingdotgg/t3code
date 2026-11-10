import type {
  AccountLink,
  CreateAccountLinkError,
  CreateAccountLinkRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Create a Stripe Account Link over HTTP. Account-scoped — binds the API
 * key onto the host, not a specific connected account.
 *
 * Account Links are the URLs a Connect platform hands a merchant to
 * complete hosted onboarding for an Express or Standard account.
 *
 * ### Onboarding a merchant
 * **Example:** Bind and create a link
 * ```typescript
 * const createLink = yield* Stripe.CreateAccountLink();
 * const link = yield* createLink({
 *   account: "acct_…",
 *   type: "account_onboarding",
 *   return_url: "https://example.com/onboarded",
 * });
 * // link.url is the hosted onboarding page
 * ```
 *
 * @binding
 * @product Account
 */
export interface CreateAccountLink extends Binding.Service<
  CreateAccountLink,
  "Stripe.CreateAccountLink",
  () => Effect.Effect<
    (
      request: CreateAccountLinkRequest,
    ) => Effect.Effect<AccountLink, CreateAccountLinkError, RuntimeContext>
  >
> {}

export const CreateAccountLink = Binding.Service<CreateAccountLink>("Stripe.CreateAccountLink");
