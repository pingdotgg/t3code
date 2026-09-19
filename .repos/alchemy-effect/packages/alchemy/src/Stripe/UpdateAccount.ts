import type {
  Account as StripeAccount,
  UpdateAccountError,
  UpdateAccountRequest as DistilledUpdateAccountRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Account } from "./Account.ts";

export interface UpdateAccountRequest extends Omit<
  DistilledUpdateAccountRequest,
  "account"
> {}

/**
 * Update a bound Stripe Connect Account over HTTP.
 *
 * ### Updating an Account
 * **Example:** Bind and update
 * ```typescript
 * const update = yield* Stripe.UpdateAccount(merchant);
 * const live = yield* update({ email: "merchant@example.com" });
 * ```
 *
 * @binding
 */
export interface UpdateAccount extends Binding.Service<
  UpdateAccount,
  "Stripe.UpdateAccount",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: UpdateAccountRequest,
    ) => Effect.Effect<StripeAccount, UpdateAccountError, RuntimeContext>
  >
> {}

export const UpdateAccount = Binding.Service<UpdateAccount>(
  "Stripe.UpdateAccount",
);
