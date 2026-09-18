import type {
  Account as StripeAccount,
  GetAccountByAccountError,
  GetAccountByAccountRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Account } from "./Account.ts";

export interface RetrieveAccountRequest extends Omit<
  GetAccountByAccountRequest,
  "account"
> {}

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

export const RetrieveAccount = Binding.Service<RetrieveAccount>(
  "Stripe.RetrieveAccount",
);
