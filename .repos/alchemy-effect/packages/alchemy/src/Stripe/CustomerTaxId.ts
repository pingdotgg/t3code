import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteCustomerTaxIds,
  GetCustomers,
  GetCustomerTaxIds,
  GetCustomerTaxIdsById,
  GetTaxIdsById,
  CreateCustomerTaxIds,
  type Customer as StripeCustomer,
  type TaxId as StripeTaxId,
  type TaxIdCustomer,
  type TaxIdType,
  type TaxIdVerificationStatus,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { alchemyMetadataKeys } from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;
const LIST_CONCURRENCY = 10;

/** Stripe tax ID type used when creating a customer tax ID (e.g. `eu_vat`). */
export type CustomerTaxIdType = Exclude<TaxIdType, "unknown">;

export interface CustomerTaxIdProps {
  /**
   * Id of the Stripe Customer to attach the tax ID to (`cus_…`).
   * Changing it replaces the tax ID.
   */
  customer: string;
  /**
   * Type of the tax ID, such as `eu_vat`, `us_ein`, or `gb_vat`.
   * Changing it replaces the tax ID.
   */
  type: CustomerTaxIdType;
  /**
   * Value of the tax ID (the VAT number, EIN, etc.). Changing it
   * replaces the tax ID.
   */
  value: string;
}

export type CustomerTaxId = Resource<
  "Stripe.CustomerTaxId",
  CustomerTaxIdProps,
  {
    /** Stripe tax ID object id (`txi_…`). */
    id: string;
    /** Id of the customer this tax ID is attached to (`cus_…`). */
    customer: string;
    /** Type of the tax ID (e.g. `eu_vat`). */
    type: TaxIdType;
    /** Value of the tax ID. */
    value: string;
    /** Two-letter ISO country code inferred from the tax ID, if known. */
    country: string | undefined;
    /** Verification status, if Stripe has attempted verification. */
    verificationStatus: TaxIdVerificationStatus | undefined;
    /** Unix timestamp when the tax ID was created. */
    created: number;
    /** Whether the tax ID exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Customer Tax ID — a tax identifier (VAT, EIN, GST, …) attached
 * to a Customer and printed on invoices. Existence-only: type and value
 * cannot be updated in place; changing `customer`, `type`, or `value`
 * replaces the tax ID. Destroy deletes it.
 *
 * Customer tax IDs have no metadata of their own. Ownership for
 * account-wide `list()` (nuke) is inferred from the parent Customer's
 * Alchemy metadata.
 *
 * @see https://docs.stripe.com/api/customer_tax_ids
 *
 * ### Creating a Customer Tax ID
 * **Example:** Attach an EU VAT number
 * ```typescript
 * const customer = yield* Stripe.Customer("alice", {
 *   email: "alice@example.com",
 * });
 * const vat = yield* Stripe.CustomerTaxId("alice-vat", {
 *   customer: customer.id,
 *   type: "eu_vat",
 *   value: "DE123456789",
 * });
 * ```
 *
 * ### Replacing a Tax ID
 * **Example:** Point at a different VAT number
 * ```typescript
 * const vat = yield* Stripe.CustomerTaxId("alice-vat", {
 *   customer: customer.id,
 *   type: "eu_vat",
 *   value: "DE000000000",
 * });
 * ```
 *
 * @resource
 */
export const CustomerTaxId = Resource<CustomerTaxId>("Stripe.CustomerTaxId");

type CustomerTaxIdAttributes = CustomerTaxId["Attributes"];

const customerIdOf = (customer: TaxIdCustomer | null): string | undefined => {
  if (customer == null) return undefined;
  if (typeof customer === "string") return customer;
  return customer.id;
};

const toAttrs = (
  customer: string,
  taxId: StripeTaxId,
): CustomerTaxIdAttributes => ({
  id: taxId.id,
  customer: customerIdOf(taxId.customer) ?? customer,
  type: taxId.type,
  value: taxId.value,
  country: taxId.country ?? undefined,
  verificationStatus: taxId.verification?.status,
  created: taxId.created,
  livemode: taxId.livemode,
});

const isMissing = isMissingStripeResource;

const getById = (id: string, customer?: string) => {
  if (customer !== undefined) {
    return GetCustomerTaxIdsById({ customer, id }).pipe(
      Effect.catchIf(isMissing, () => Effect.succeed(undefined)),
    );
  }
  return GetTaxIdsById({ id }).pipe(
    Effect.catchIf(isMissing, () => Effect.succeed(undefined)),
  );
};

const listTaxIds = Effect.fn(function* (customer: string) {
  const taxIds: StripeTaxId[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetCustomerTaxIds({
      customer,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    }).pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)));
    if (response === undefined) {
      break;
    }
    taxIds.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return taxIds;
});

const findByTypeValue = Effect.fn(function* (
  customer: string,
  type: string,
  value: string,
) {
  const taxIds = yield* listTaxIds(customer);
  const matches = taxIds.filter(
    (taxId) => taxId.type === type && taxId.value === value,
  );
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const listAllCustomers = Effect.fn(function* () {
  const customers: StripeCustomer[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetCustomers({
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    customers.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return customers;
});

const listAlchemyCustomers = Effect.fn(function* () {
  const customers = yield* listAllCustomers();
  return customers.filter(
    (customer) =>
      tagRecord(customer.metadata)[alchemyMetadataKeys.stack] !== undefined,
  );
});

const observe = Effect.fn(function* (input: {
  id?: string;
  customer?: string;
  type?: string;
  value?: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id, input.customer);
    if (byId !== undefined) return byId;
  }
  if (
    input.customer !== undefined &&
    input.type !== undefined &&
    input.value !== undefined
  ) {
    return yield* findByTypeValue(input.customer, input.type, input.value);
  }
  return undefined;
});

const shouldReplace = (
  news: CustomerTaxIdProps,
  output: CustomerTaxIdAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.customer !== output.customer) return true;
  if (news.type !== output.type) return true;
  if (news.value !== output.value) return true;
  return false;
};

export const CustomerTaxIdProvider = () =>
  Provider.succeed(CustomerTaxId, {
    stables: [
      "id",
      "customer",
      "type",
      "value",
      "country",
      "verificationStatus",
      "created",
      "livemode",
    ],
    nuke: { dependsOn: ["Stripe.Customer"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const customer =
        output?.customer ??
        (typeof olds?.customer === "string" ? olds.customer : undefined);
      const type =
        output?.type ??
        (typeof olds?.type === "string" ? olds.type : undefined);
      const value =
        output?.value ??
        (typeof olds?.value === "string" ? olds.value : undefined);
      const existing = yield* observe({
        id: output?.id,
        customer,
        type,
        value,
      });
      if (existing === undefined || customer === undefined) return undefined;
      return toAttrs(customer, existing);
    }),

    list: Effect.fn(function* () {
      // Customer tax IDs have no metadata. Fan out from alchemy-owned
      // customers so nuke only tears down tax IDs we created.
      const customers = yield* listAlchemyCustomers();
      const rows = yield* Effect.forEach(
        customers,
        (customer) =>
          listTaxIds(customer.id).pipe(
            Effect.map((taxIds) =>
              taxIds.map((taxId) => toAttrs(customer.id, taxId)),
            ),
          ),
        { concurrency: LIST_CONCURRENCY },
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ news, output, instanceId }) {
      let current = yield* observe({
        id: output?.id,
        customer: news.customer,
        type: news.type,
        value: news.value,
      });
      if (
        current !== undefined &&
        shouldReplace(news, toAttrs(news.customer, current))
      ) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateCustomerTaxIds({
          customer: news.customer,
          type: news.type,
          value: news.value,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-customer-tax-id-${instanceId}`,
          }),
          Effect.catchIf(
            (e) => e._tag === "InvalidRequestError" || e._tag === "Conflict",
            (e) =>
              observe({
                customer: news.customer,
                type: news.type,
                value: news.value,
              }).pipe(
                Effect.flatMap((found) =>
                  found !== undefined ? Effect.succeed(found) : Effect.fail(e),
                ),
              ),
          ),
        );
      }

      return toAttrs(news.customer, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteCustomerTaxIds({
        customer: output.customer,
        id: output.id,
      }).pipe(Effect.catchIf(isMissing, () => Effect.void));
    }),
  });
