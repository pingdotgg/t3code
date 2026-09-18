import { GetAccountPerson } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import type { AccountPerson } from "./AccountPerson.ts";
import { RetrieveAccountPerson } from "./RetrieveAccountPerson.ts";
import {
  asStringEffect,
  attachStripeToken,
  authorizeWith,
  resolveStripeAuth,
} from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveAccountPerson}. Retrieve takes
 * both `account` and `person`.
 *
 * @layer
 * @provides Stripe.RetrieveAccountPerson
 */
export const RetrieveAccountPersonHttp = Layer.effect(
  RetrieveAccountPerson,
  Effect.gen(function* () {
    const ambient = yield* resolveStripeAuth;

    return Effect.fn(function* (person: AccountPerson) {
      const host = yield* Binding.Host;
      const bound = yield* attachStripeToken(
        person as unknown as ResourceLike,
        ["accounts_read"],
        "Stripe.RetrieveAccountPerson",
      );
      const id = yield* asStringEffect(person.id);
      const account = yield* asStringEffect(person.account);
      const auth =
        host !== undefined ? authorizeWith(bound) : ambient.authorize;

      return Effect.fn(`Stripe.RetrieveAccountPerson(${person.LogicalId})`)(
        function* (request?: { expand?: string[] }) {
          return yield* auth(
            GetAccountPerson({
              ...(request ?? {}),
              person: yield* id,
              account: yield* account,
            }),
          );
        },
      );
    });
  }),
);
