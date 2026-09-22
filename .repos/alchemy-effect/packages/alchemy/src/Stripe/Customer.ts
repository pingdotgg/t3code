import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteCustomer,
  GetCustomers,
  GetCustomer,
  CreateCustomer,
  UpdateCustomer,
  type Customer as StripeCustomer,
  type DeletedCustomer,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

export interface CustomerProps {
  /**
   * Customer's email address. Displayed in the Stripe dashboard and
   * useful for searching. At most 512 characters.
   */
  email?: string;
  /**
   * The customer's full name or business name.
   */
  name?: string;
  /**
   * An arbitrary string attached to the customer. Displayed alongside
   * the customer in the dashboard.
   */
  description?: string;
  /**
   * The customer's phone number.
   */
  phone?: string;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`.
   */
  metadata?: Record<string, string>;
}

export type Customer = Resource<
  "Stripe.Customer",
  CustomerProps,
  {
    /** Stripe customer id (`cus_…`). */
    id: string;
    /** Customer's email address, if set. */
    email: string | undefined;
    /** The customer's full name or business name, if set. */
    name: string | undefined;
    /** Arbitrary description displayed in the dashboard, if set. */
    description: string | undefined;
    /** The customer's phone number, if set. */
    phone: string | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the customer was created. */
    created: number;
    /** Whether the customer exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Customer — the billing identity invoices, subscriptions, and
 * Checkout sessions attach to. Email, name, description, phone, and
 * metadata are updated in place. Deleting a customer is permanent and
 * immediately cancels any active subscriptions.
 *
 * @see https://docs.stripe.com/api/customers
 *
 * ### Creating a Customer
 * **Example:** Email and name
 * ```typescript
 * const customer = yield* Stripe.Customer("alice", {
 *   email: "alice@example.com",
 *   name: "Alice Example",
 * });
 * ```
 *
 * **Example:** Description, phone, and metadata
 * ```typescript
 * const customer = yield* Stripe.Customer("alice", {
 *   email: "alice@example.com",
 *   name: "Alice Example",
 *   description: "Beta tester",
 *   phone: "+15555550100",
 *   metadata: { plan: "pro" },
 * });
 * ```
 *
 * ### Updating a Customer
 * **Example:** Change email and metadata
 * ```typescript
 * const customer = yield* Stripe.Customer("alice", {
 *   email: "alice+updated@example.com",
 *   name: "Alice Example",
 *   metadata: { plan: "enterprise" },
 * });
 * ```
 *
 * @resource
 */
export const Customer = Resource<Customer>("Stripe.Customer");

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const isDeletedCustomer = (
  value: StripeCustomer | DeletedCustomer,
): value is DeletedCustomer => "deleted" in value && value.deleted === true;

const asCustomer = (
  value: StripeCustomer | DeletedCustomer | undefined,
): StripeCustomer | undefined => {
  if (value === undefined || isDeletedCustomer(value)) return undefined;
  return value;
};

const toAttrs = (customer: StripeCustomer) => ({
  id: customer.id,
  email: customer.email ?? undefined,
  name: customer.name ?? undefined,
  description: customer.description ?? undefined,
  phone: customer.phone ?? undefined,
  metadata: userMetadata(customer.metadata),
  created: customer.created,
  livemode: customer.livemode,
});

const isMissingCustomer = isMissingStripeResource;

const getById = (customer: string) =>
  GetCustomer({ customer }).pipe(
    Effect.map(asCustomer),
    Effect.catchIf(isMissingCustomer, () => Effect.succeed(undefined)),
  );

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

const findByAlchemyId = Effect.fn(function* (id: string) {
  const customers = yield* listAllCustomers();
  const matches: StripeCustomer[] = [];
  for (const customer of customers) {
    if (yield* hasAlchemyMetadata(id, tagRecord(customer.metadata))) {
      matches.push(customer);
    }
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const observe = Effect.fn(function* (input: {
  id?: string;
  logicalId: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  return yield* findByAlchemyId(input.logicalId);
});

const desiredMetadata = Effect.fn(function* (
  id: string,
  metadata: Record<string, string> | undefined,
) {
  return {
    ...toMetadata(metadata),
    ...(yield* createInternalMetadata(id)),
  };
});

export const CustomerProvider = () =>
  Provider.succeed(Customer, {
    stables: ["id", "created", "livemode"],

    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      const existing = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const customers = yield* listAllCustomers();
      return customers
        .filter((customer) => {
          const metadata = tagRecord(customer.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredEmail = news.email ?? "";
      const desiredName = news.name ?? "";
      const desiredDescription = news.description ?? "";
      const desiredPhone = news.phone ?? "";

      let current = yield* observe({
        id: output?.id,
        logicalId: id,
      });

      if (current === undefined) {
        current = yield* CreateCustomer({
          ...(desiredEmail.length > 0 ? { email: desiredEmail } : {}),
          ...(desiredName.length > 0 ? { name: desiredName } : {}),
          ...(desiredDescription.length > 0
            ? { description: desiredDescription }
            : {}),
          ...(desiredPhone.length > 0 ? { phone: desiredPhone } : {}),
          metadata,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-customer-${instanceId}`,
          }),
        );
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const emailChanged = (current.email ?? "") !== desiredEmail;
      const nameChanged = (current.name ?? "") !== desiredName;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const phoneChanged = (current.phone ?? "") !== desiredPhone;

      if (
        !emailChanged &&
        !nameChanged &&
        !descriptionChanged &&
        !phoneChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdateCustomer({
        customer: current.id,
        ...(emailChanged ? { email: desiredEmail } : {}),
        ...(nameChanged ? { name: desiredName } : {}),
        ...(descriptionChanged ? { description: desiredDescription } : {}),
        ...(phoneChanged ? { phone: desiredPhone } : {}),
        ...(metadataChanged
          ? {
              metadata: {
                ...Object.fromEntries(
                  upsert.map((tag) => [tag.Key, tag.Value]),
                ),
                ...Object.fromEntries(removed.map((key) => [key, ""])),
              },
            }
          : {}),
      });
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteCustomer({ customer: output.id }).pipe(
        Effect.catchIf(isMissingCustomer, () => Effect.void),
      );
    }),
  });
