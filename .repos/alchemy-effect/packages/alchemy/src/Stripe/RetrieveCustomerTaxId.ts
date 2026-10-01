import type {
  GetCustomerTaxIdsByIdError,
  GetCustomerTaxIdsByIdRequest,
  TaxId as StripeTaxId,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { CustomerTaxId } from "./CustomerTaxId.ts";

export interface RetrieveCustomerTaxIdRequest extends Omit<
  GetCustomerTaxIdsByIdRequest,
  "id" | "customer"
> {}

/**
 * Retrieve a bound Stripe Customer Tax ID over HTTP.
 *
 * ### Reading a Customer Tax ID
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveCustomerTaxId(vat);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveCustomerTaxId extends Binding.Service<
  RetrieveCustomerTaxId,
  "Stripe.RetrieveCustomerTaxId",
  (
    taxId: CustomerTaxId,
  ) => Effect.Effect<
    (
      request?: RetrieveCustomerTaxIdRequest,
    ) => Effect.Effect<StripeTaxId, GetCustomerTaxIdsByIdError, RuntimeContext>
  >
> {}

export const RetrieveCustomerTaxId = Binding.Service<RetrieveCustomerTaxId>(
  "Stripe.RetrieveCustomerTaxId",
);
