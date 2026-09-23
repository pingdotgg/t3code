import type {
  ExternalAccount as StripeExternalAccount,
  GetAccountExternalAccountError,
  GetAccountExternalAccountRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { AccountExternalAccount } from "./AccountExternalAccount.ts";

export interface RetrieveAccountExternalAccountRequest extends Omit<
  GetAccountExternalAccountRequest,
  "id" | "account"
> {}

/**
 * Retrieve a bound Stripe Account External Account over HTTP.
 *
 * ### Reading an External Account
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveAccountExternalAccount(payout);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveAccountExternalAccount extends Binding.Service<
  RetrieveAccountExternalAccount,
  "Stripe.RetrieveAccountExternalAccount",
  (
    externalAccount: AccountExternalAccount,
  ) => Effect.Effect<
    (
      request?: RetrieveAccountExternalAccountRequest,
    ) => Effect.Effect<
      StripeExternalAccount,
      GetAccountExternalAccountError,
      RuntimeContext
    >
  >
> {}

export const RetrieveAccountExternalAccount =
  Binding.Service<RetrieveAccountExternalAccount>(
    "Stripe.RetrieveAccountExternalAccount",
  );
