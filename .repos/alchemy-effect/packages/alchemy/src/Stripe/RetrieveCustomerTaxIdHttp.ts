import { GetCustomerTaxIdsById } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import type { CustomerTaxId } from "./CustomerTaxId.ts";
import { RetrieveCustomerTaxId } from "./RetrieveCustomerTaxId.ts";
import {
  asStringEffect,
  attachStripeToken,
  authorizeWith,
  resolveStripeAuth,
} from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveCustomerTaxId}. The nested
 * retrieve takes both `customer` and `id`.
 *
 * @layer
 * @provides Stripe.RetrieveCustomerTaxId
 */
export const RetrieveCustomerTaxIdHttp = Layer.effect(
  RetrieveCustomerTaxId,
  Effect.gen(function* () {
    const ambient = yield* resolveStripeAuth;

    return Effect.fn(function* (taxId: CustomerTaxId) {
      const host = yield* Binding.Host;
      const bound = yield* attachStripeToken(
        taxId as unknown as ResourceLike,
        ["customers_read"],
        "Stripe.RetrieveCustomerTaxId",
      );
      const id = yield* asStringEffect(taxId.id);
      const customer = yield* asStringEffect(taxId.customer);
      const auth =
        host !== undefined ? authorizeWith(bound) : ambient.authorize;

      return Effect.fn(`Stripe.RetrieveCustomerTaxId(${taxId.LogicalId})`)(
        function* (request?: { expand?: string[] }) {
          return yield* auth(
            GetCustomerTaxIdsById({
              ...(request ?? {}),
              id: yield* id,
              customer: yield* customer,
            }),
          );
        },
      );
    });
  }),
);
