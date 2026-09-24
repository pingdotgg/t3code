import { GetAccountExternalAccount } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import type { AccountExternalAccount } from "./AccountExternalAccount.ts";
import { RetrieveAccountExternalAccount } from "./RetrieveAccountExternalAccount.ts";
import {
  asStringEffect,
  attachStripeToken,
  authorizeWith,
  resolveStripeAuth,
} from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveAccountExternalAccount}. The
 * nested retrieve takes both `account` and `id`.
 *
 * @layer
 * @provides Stripe.RetrieveAccountExternalAccount
 */
export const RetrieveAccountExternalAccountHttp = Layer.effect(
  RetrieveAccountExternalAccount,
  Effect.gen(function* () {
    const ambient = yield* resolveStripeAuth;

    return Effect.fn(function* (externalAccount: AccountExternalAccount) {
      const host = yield* Binding.Host;
      const bound = yield* attachStripeToken(
        externalAccount as unknown as ResourceLike,
        ["accounts_read"],
        "Stripe.RetrieveAccountExternalAccount",
      );
      const id = yield* asStringEffect(externalAccount.id);
      const account = yield* asStringEffect(externalAccount.account);
      const auth =
        host !== undefined ? authorizeWith(bound) : ambient.authorize;

      return Effect.fn(
        `Stripe.RetrieveAccountExternalAccount(${externalAccount.LogicalId})`,
      )(function* (request?: { expand?: string[] }) {
        return yield* auth(
          GetAccountExternalAccount({
            ...(request ?? {}),
            id: yield* id,
            account: yield* account,
          }),
        );
      });
    });
  }),
);
