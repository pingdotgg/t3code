import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetPaymentLinks,
  GetPaymentLink,
  GetPaymentLinkLineItems,
  CreatePaymentLink,
  UpdatePaymentLink,
  type Item as StripeLineItem,
  type PaymentLink as StripePaymentLink,
  type CreatePaymentLinkRequestAfterCompletion,
  type CreatePaymentLinkRequestLineItemsItem,
  type UpdatePaymentLinkRequestAfterCompletion,
  type UpdatePaymentLinkRequestLineItemsItem,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
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

export type PaymentLinkBillingAddressCollection = "auto" | "required";
export type PaymentLinkCustomerCreation = "always" | "if_required";
export type PaymentLinkPaymentMethodCollection = "always" | "if_required";
export type PaymentLinkSubmitType =
  | "auto"
  | "book"
  | "donate"
  | "pay"
  | "subscribe";
export type PaymentLinkAfterCompletionType = "hosted_confirmation" | "redirect";

export interface PaymentLinkLineItemAdjustableQuantity {
  /**
   * When true, the customer can change this item's quantity at checkout.
   */
  enabled: boolean;
  /**
   * Minimum quantity the customer can purchase. Defaults to `0`.
   */
  minimum?: number;
  /**
   * Maximum quantity the customer can purchase. Defaults to `99`.
   */
  maximum?: number;
}

export interface PaymentLinkLineItem {
  /**
   * Stripe Price id (`price_…`). Changing the set of prices replaces
   * the payment link — existing items can only change quantity.
   */
  price: string;
  /**
   * Quantity of this line item. Mutable for existing items.
   */
  quantity: number;
  /**
   * When set, the customer can adjust quantity during checkout.
   */
  adjustableQuantity?: PaymentLinkLineItemAdjustableQuantity;
}

export interface PaymentLinkAfterCompletionHostedConfirmation {
  /**
   * Custom message shown on Stripe's hosted confirmation page.
   */
  customMessage?: string;
}

export interface PaymentLinkAfterCompletionRedirect {
  /**
   * URL the customer is sent to after purchase. `{CHECKOUT_SESSION_ID}`
   * is substituted with the completed session id.
   */
  url: string;
}

export interface PaymentLinkAfterCompletion {
  /**
   * `hosted_confirmation` shows Stripe's confirmation page;
   * `redirect` sends the customer to `redirect.url`.
   */
  type: PaymentLinkAfterCompletionType;
  /**
   * Configuration when `type` is `hosted_confirmation`.
   */
  hostedConfirmation?: PaymentLinkAfterCompletionHostedConfirmation;
  /**
   * Configuration when `type` is `redirect`.
   */
  redirect?: PaymentLinkAfterCompletionRedirect;
}

export interface PaymentLinkProps {
  /**
   * Line items sold by this payment link. At least one is required.
   * Changing the set of prices replaces the link; quantity and
   * `adjustableQuantity` of existing items update in place.
   */
  lineItems: PaymentLinkLineItem[];
  /**
   * Whether the payment link URL is active. When `false`, visitors see
   * a deactivated page (and `inactiveMessage` if set).
   * @default true
   */
  active?: boolean;
  /**
   * Whether customers can enter promotion codes at checkout.
   * @default false
   */
  allowPromotionCodes?: boolean;
  /**
   * How Checkout collects a billing address. `auto` collects one when
   * needed (tax, shipping); `required` always collects it.
   * @default "auto"
   */
  billingAddressCollection?: PaymentLinkBillingAddressCollection;
  /**
   * Behavior after the purchase completes.
   */
  afterCompletion?: PaymentLinkAfterCompletion;
  /**
   * Custom message shown when the payment link is inactive.
   */
  inactiveMessage?: string;
  /**
   * Submit-button copy and `buy.stripe.com` / `donate.stripe.com`
   * hostname. `auto` infers from the line items.
   * @default "auto"
   */
  submitType?: PaymentLinkSubmitType;
  /**
   * Whether Checkout Sessions created by this link also create a
   * Customer. `if_required` only creates one when needed.
   * @default "if_required"
   */
  customerCreation?: PaymentLinkCustomerCreation;
  /**
   * Whether Checkout collects a payment method. `if_required` skips
   * collection when the total due is 0 (subscription mode only).
   * @default "always"
   */
  paymentMethodCollection?: PaymentLinkPaymentMethodCollection;
  /**
   * When true, Checkout collects a phone number.
   * @default false
   */
  phoneNumberCollection?: boolean;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`. Copied onto Checkout Sessions created by this link.
   */
  metadata?: Record<string, string>;
}

export type PaymentLink = Resource<
  "Stripe.PaymentLink",
  PaymentLinkProps,
  {
    /** Stripe payment link id (`plink_…`). */
    id: string;
    /** Public URL customers open to pay. */
    url: string;
    /** Whether the payment link URL is active. */
    active: boolean;
    /** Line items sold by this payment link. */
    lineItems: PaymentLinkLineItem[];
    /** Whether customers can enter promotion codes at checkout. */
    allowPromotionCodes: boolean;
    /** How Checkout collects a billing address. */
    billingAddressCollection: PaymentLinkBillingAddressCollection;
    /** Behavior after the purchase completes. */
    afterCompletion: PaymentLinkAfterCompletion;
    /** Custom message shown when the payment link is inactive. */
    inactiveMessage: string | undefined;
    /** Submit-button copy / hostname hint. */
    submitType: PaymentLinkSubmitType;
    /** Whether Checkout Sessions create a Customer. */
    customerCreation: PaymentLinkCustomerCreation;
    /** Whether Checkout collects a payment method. */
    paymentMethodCollection: PaymentLinkPaymentMethodCollection;
    /** Whether Checkout collects a phone number. */
    phoneNumberCollection: boolean;
    /** Three-letter ISO currency code. */
    currency: string;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Whether the payment link exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Payment Link — a shareable URL that opens a hosted Checkout
 * page. Requires at least one `lineItems` price. Quantity, metadata,
 * `active`, and most Checkout options update in place; changing the set
 * of prices replaces the link. Payment links cannot be deleted; destroy
 * deactivates them (`active=false`).
 *
 * @see https://docs.stripe.com/api/payment_links
 *
 * ### Creating a Payment Link
 * **Example:** One-time price
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan", { name: "Pro Plan" });
 * const price = yield* Stripe.Price("pro-once", {
 *   product: product.id,
 *   currency: "usd",
 *   unitAmount: 2000,
 * });
 * const link = yield* Stripe.PaymentLink("buy", {
 *   lineItems: [{ price: price.id, quantity: 1 }],
 * });
 * ```
 *
 * **Example:** Promotion codes and a confirmation message
 * ```typescript
 * const link = yield* Stripe.PaymentLink("buy", {
 *   lineItems: [{ price: price.id, quantity: 1 }],
 *   allowPromotionCodes: true,
 *   afterCompletion: {
 *     type: "hosted_confirmation",
 *     hostedConfirmation: { customMessage: "Thanks for your order." },
 *   },
 *   metadata: { campaign: "launch" },
 * });
 * ```
 *
 * ### Updating a Payment Link
 * **Example:** Quantity, metadata, and deactivate
 * ```typescript
 * const link = yield* Stripe.PaymentLink("buy", {
 *   lineItems: [{ price: price.id, quantity: 2 }],
 *   active: false,
 *   inactiveMessage: "This link is no longer available.",
 *   metadata: { campaign: "paused" },
 * });
 * ```
 *
 * @resource
 */
export const PaymentLink = Resource<PaymentLink>("Stripe.PaymentLink");

export class PaymentLinkNotResolved extends Data.TaggedError(
  "Stripe.PaymentLinkNotResolved",
)<{
  lineItems: PaymentLinkLineItem[];
}> {}

type PaymentLinkAttributes = PaymentLink["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const priceIdOf = (
  price: StripeLineItem["price"] | string | null | undefined,
): string | undefined => {
  if (price == null) return undefined;
  if (typeof price === "string") return price;
  return price.id;
};

const fromObservedAdjustableQuantity = (
  value: StripeLineItem["adjustable_quantity"],
): PaymentLinkLineItemAdjustableQuantity | undefined => {
  if (value == null) return undefined;
  return {
    enabled: value.enabled,
    ...(value.minimum != null ? { minimum: value.minimum } : {}),
    ...(value.maximum != null ? { maximum: value.maximum } : {}),
  };
};

const fromObservedLineItems = (
  items: ReadonlyArray<StripeLineItem> | undefined,
): PaymentLinkLineItem[] => {
  if (items === undefined) return [];
  const out: PaymentLinkLineItem[] = [];
  for (const item of items) {
    const price = priceIdOf(item.price);
    if (price === undefined) continue;
    const adjustableQuantity = fromObservedAdjustableQuantity(
      item.adjustable_quantity,
    );
    out.push({
      price,
      quantity: item.quantity ?? 1,
      ...(adjustableQuantity !== undefined ? { adjustableQuantity } : {}),
    });
  }
  return out;
};

const fromObservedAfterCompletion = (
  value: StripePaymentLink["after_completion"],
): PaymentLinkAfterCompletion => ({
  type: value.type,
  ...(value.hosted_confirmation !== undefined
    ? {
        hostedConfirmation: {
          ...(value.hosted_confirmation.custom_message != null
            ? { customMessage: value.hosted_confirmation.custom_message }
            : {}),
        },
      }
    : {}),
  ...(value.redirect !== undefined
    ? { redirect: { url: value.redirect.url } }
    : {}),
});

const toWireAfterCompletion = (
  value: PaymentLinkAfterCompletion,
): CreatePaymentLinkRequestAfterCompletion => ({
  type: value.type,
  ...(value.type === "hosted_confirmation"
    ? {
        hosted_confirmation: {
          ...(value.hostedConfirmation?.customMessage !== undefined
            ? { custom_message: value.hostedConfirmation.customMessage }
            : {}),
        },
      }
    : {}),
  ...(value.type === "redirect" && value.redirect !== undefined
    ? { redirect: { url: value.redirect.url } }
    : {}),
});

const toWireCreateLineItems = (
  items: PaymentLinkLineItem[],
): CreatePaymentLinkRequestLineItemsItem[] =>
  items.map((item) => ({
    price: item.price,
    quantity: item.quantity,
    ...(item.adjustableQuantity !== undefined
      ? {
          adjustable_quantity: {
            enabled: item.adjustableQuantity.enabled,
            ...(item.adjustableQuantity.minimum !== undefined
              ? { minimum: item.adjustableQuantity.minimum }
              : {}),
            ...(item.adjustableQuantity.maximum !== undefined
              ? { maximum: item.adjustableQuantity.maximum }
              : {}),
          },
        }
      : {}),
  }));

const toAttrs = (link: StripePaymentLink): PaymentLinkAttributes => ({
  id: link.id,
  url: link.url,
  active: link.active,
  lineItems: fromObservedLineItems(link.line_items?.data),
  allowPromotionCodes: link.allow_promotion_codes,
  billingAddressCollection: link.billing_address_collection,
  afterCompletion: fromObservedAfterCompletion(link.after_completion),
  inactiveMessage: link.inactive_message ?? undefined,
  submitType: link.submit_type,
  customerCreation: link.customer_creation,
  paymentMethodCollection: link.payment_method_collection,
  phoneNumberCollection: link.phone_number_collection.enabled,
  currency: link.currency,
  metadata: userMetadata(link.metadata),
  livemode: link.livemode,
});

const isMissingPaymentLink = isMissingStripeResource;

const hydrateLineItems = (link: StripePaymentLink) =>
  Effect.gen(function* () {
    const data: StripeLineItem[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const response = yield* GetPaymentLinkLineItems({
        payment_link: link.id,
        limit: LIST_PAGE_SIZE,
        ...(startingAfter !== undefined
          ? { starting_after: startingAfter }
          : {}),
      });
      data.push(...response.data);
      if (!response.has_more || response.data.length === 0) {
        break;
      }
      startingAfter = response.data[response.data.length - 1]?.id;
      if (startingAfter === undefined) {
        break;
      }
    }
    return {
      ...link,
      line_items: {
        data,
        has_more: false,
        object: "list" as const,
        url: link.line_items?.url ?? `/v1/payment_links/${link.id}/line_items`,
      },
    };
  });

const getById = (payment_link: string) =>
  GetPaymentLink({ payment_link }).pipe(
    Effect.catchIf(isMissingPaymentLink, () => Effect.succeed(undefined)),
    Effect.flatMap((link) =>
      link === undefined ? Effect.succeed(undefined) : hydrateLineItems(link),
    ),
  );

const listByActive = Effect.fn(function* (active: boolean) {
  const links: StripePaymentLink[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetPaymentLinks({
      active,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    links.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return links;
});

const listAllPaymentLinks = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all(
    [listByActive(true), listByActive(false)],
    { concurrency: 2 },
  );
  const seen = new Set<string>();
  const links: StripePaymentLink[] = [];
  for (const link of [...active, ...inactive]) {
    if (seen.has(link.id)) continue;
    seen.add(link.id);
    links.push(link);
  }
  return links;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const links = yield* listAllPaymentLinks();
  const matches: StripePaymentLink[] = [];
  for (const link of links) {
    if (yield* hasAlchemyMetadata(id, tagRecord(link.metadata))) {
      matches.push(link);
    }
  }
  matches.sort((a, b) => Number(b.active) - Number(a.active));
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
  const found = yield* findByAlchemyId(input.logicalId);
  if (found === undefined) return undefined;
  return yield* getById(found.id);
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

const shouldReplace = (
  news: PaymentLinkProps,
  output: PaymentLinkAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (output.lineItems.length === 0) return false;
  if (news.lineItems.length !== output.lineItems.length) return true;
  return news.lineItems.some(
    (item, index) => item.price !== output.lineItems[index]?.price,
  );
};

const adjustableQuantityEqual = (
  desired: PaymentLinkLineItemAdjustableQuantity | undefined,
  observed: PaymentLinkLineItemAdjustableQuantity | undefined,
): boolean => {
  if (desired === undefined) return true;
  return deepEqual(desired, observed, { stripNullish: true });
};

const lineItemsNeedUpdate = (
  desired: PaymentLinkLineItem[],
  observedItems: ReadonlyArray<StripeLineItem>,
): boolean => {
  if (desired.length !== observedItems.length) return false;
  return desired.some((item, index) => {
    const observed = observedItems[index];
    if (observed === undefined) return false;
    if ((observed.quantity ?? 1) !== item.quantity) return true;
    return !adjustableQuantityEqual(
      item.adjustableQuantity,
      fromObservedAdjustableQuantity(observed.adjustable_quantity),
    );
  });
};

const toWireUpdateLineItems = (
  desired: PaymentLinkLineItem[],
  observedItems: ReadonlyArray<StripeLineItem>,
): UpdatePaymentLinkRequestLineItemsItem[] | undefined => {
  if (desired.length !== observedItems.length) return undefined;
  const items: UpdatePaymentLinkRequestLineItemsItem[] = [];
  for (let index = 0; index < desired.length; index++) {
    const item = desired[index];
    const observed = observedItems[index];
    if (item === undefined || observed === undefined) return undefined;
    items.push({
      id: observed.id,
      quantity: item.quantity,
      ...(item.adjustableQuantity !== undefined
        ? {
            adjustable_quantity: {
              enabled: item.adjustableQuantity.enabled,
              ...(item.adjustableQuantity.minimum !== undefined
                ? { minimum: item.adjustableQuantity.minimum }
                : {}),
              ...(item.adjustableQuantity.maximum !== undefined
                ? { maximum: item.adjustableQuantity.maximum }
                : {}),
            },
          }
        : {}),
    });
  }
  return items;
};

export const PaymentLinkProvider = () =>
  Provider.succeed(PaymentLink, {
    stables: ["id", "currency", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
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
      // Default list API is active payment links; deactivated rows stay
      // in Stripe but must not re-enter nuke. Filter to alchemy_stack so
      // account-wide teardown only touches our rows.
      const links = yield* listByActive(true);
      return links
        .filter((link) => {
          const metadata = tagRecord(link.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredActive = news.active ?? true;
      const afterCompletion = news.afterCompletion;

      let current: StripePaymentLink | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreatePaymentLink({
          line_items: toWireCreateLineItems(news.lineItems),
          metadata,
          ...(news.allowPromotionCodes !== undefined
            ? { allow_promotion_codes: news.allowPromotionCodes }
            : {}),
          ...(news.billingAddressCollection !== undefined
            ? { billing_address_collection: news.billingAddressCollection }
            : {}),
          ...(news.submitType !== undefined
            ? { submit_type: news.submitType }
            : {}),
          ...(news.customerCreation !== undefined
            ? { customer_creation: news.customerCreation }
            : {}),
          ...(news.paymentMethodCollection !== undefined
            ? { payment_method_collection: news.paymentMethodCollection }
            : {}),
          ...(news.phoneNumberCollection !== undefined
            ? {
                phone_number_collection: {
                  enabled: news.phoneNumberCollection,
                },
              }
            : {}),
          ...(news.inactiveMessage !== undefined
            ? { inactive_message: news.inactiveMessage }
            : {}),
          ...(afterCompletion !== undefined
            ? { after_completion: toWireAfterCompletion(afterCompletion) }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-payment-link-${instanceId}`,
          }),
        );
        current = yield* hydrateLineItems(current);
      }

      if (current === undefined) {
        return yield* new PaymentLinkNotResolved({
          lineItems: news.lineItems,
        });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const activeChanged = current.active !== desiredActive;
      const allowPromotionCodesChanged =
        news.allowPromotionCodes !== undefined &&
        current.allow_promotion_codes !== news.allowPromotionCodes;
      const billingChanged =
        news.billingAddressCollection !== undefined &&
        current.billing_address_collection !== news.billingAddressCollection;
      const submitTypeChanged =
        news.submitType !== undefined &&
        current.submit_type !== news.submitType;
      const customerCreationChanged =
        news.customerCreation !== undefined &&
        current.customer_creation !== news.customerCreation;
      const paymentMethodCollectionChanged =
        news.paymentMethodCollection !== undefined &&
        current.payment_method_collection !== news.paymentMethodCollection;
      const phoneChanged =
        news.phoneNumberCollection !== undefined &&
        current.phone_number_collection.enabled !== news.phoneNumberCollection;
      const inactiveMessageChanged =
        news.inactiveMessage !== undefined &&
        (current.inactive_message ?? "") !== news.inactiveMessage;
      const afterCompletionChanged =
        afterCompletion !== undefined &&
        !deepEqual(
          afterCompletion,
          fromObservedAfterCompletion(current.after_completion),
          { stripNullish: true },
        );
      const observedLineItems = current.line_items?.data ?? [];
      const lineItemsChanged = lineItemsNeedUpdate(
        news.lineItems,
        observedLineItems,
      );
      const updateLineItems = lineItemsChanged
        ? toWireUpdateLineItems(news.lineItems, observedLineItems)
        : undefined;

      if (
        !activeChanged &&
        !allowPromotionCodesChanged &&
        !billingChanged &&
        !submitTypeChanged &&
        !customerCreationChanged &&
        !paymentMethodCollectionChanged &&
        !phoneChanged &&
        !inactiveMessageChanged &&
        !afterCompletionChanged &&
        !lineItemsChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdatePaymentLink({
        payment_link: current.id,
        ...(activeChanged ? { active: desiredActive } : {}),
        ...(allowPromotionCodesChanged
          ? { allow_promotion_codes: news.allowPromotionCodes }
          : {}),
        ...(billingChanged
          ? { billing_address_collection: news.billingAddressCollection }
          : {}),
        ...(submitTypeChanged ? { submit_type: news.submitType } : {}),
        ...(customerCreationChanged
          ? { customer_creation: news.customerCreation }
          : {}),
        ...(paymentMethodCollectionChanged
          ? { payment_method_collection: news.paymentMethodCollection }
          : {}),
        ...(phoneChanged
          ? {
              phone_number_collection: {
                enabled: news.phoneNumberCollection === true,
              },
            }
          : {}),
        ...(inactiveMessageChanged
          ? { inactive_message: news.inactiveMessage }
          : {}),
        ...(afterCompletionChanged && afterCompletion !== undefined
          ? {
              after_completion: toWireAfterCompletion(
                afterCompletion,
              ) as UpdatePaymentLinkRequestAfterCompletion,
            }
          : {}),
        ...(updateLineItems !== undefined
          ? { line_items: updateLineItems }
          : {}),
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
      return toAttrs(yield* hydrateLineItems(updated));
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || !existing.active) return;
      yield* UpdatePaymentLink({
        payment_link: existing.id,
        active: false,
      }).pipe(Effect.catchIf(isMissingPaymentLink, () => Effect.void));
    }),
  });
