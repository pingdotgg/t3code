import type {
  Account as StripeAccount,
  GetAccountByAccountError,
  GetAccountByAccountRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface RetrieveAccountRequest extends Omit<GetAccountByAccountRequest, "account"> {}

/**
 * Retrieve a bound Stripe Connect Account over HTTP.
 *
 * ### Reading an Account
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveAccount(merchant);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Account
 */
export interface RetrieveAccount extends Binding.Service<
  RetrieveAccount,
  "Stripe.RetrieveAccount",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: RetrieveAccountRequest,
    ) => Effect.Effect<StripeAccount, GetAccountByAccountError, RuntimeContext>
  >
> {}

export const RetrieveAccount = Binding.Service<RetrieveAccount>("Stripe.RetrieveAccount");
