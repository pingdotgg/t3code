import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetPaymentMethodDomains,
  GetPaymentMethodDomain,
  CreatePaymentMethodDomain,
  UpdatePaymentMethodDomain,
  type PaymentMethodDomain as StripePaymentMethodDomain,
  type PaymentMethodDomainResourcePaymentMethodStatus,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const DOMAIN_SUFFIX = ".example.com";
const DOMAIN_LABEL_MAX_LENGTH = 63;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** The status of a payment method on a registered domain. */
export type PaymentMethodDomainStatus = "active" | "inactive";

export interface PaymentMethodDomainPaymentMethodStatus {
  /**
   * Whether the payment method is active on this domain.
   */
  status: PaymentMethodDomainStatus;
  /**
   * Extra details when the payment method is inactive, including the
   * error message from Stripe.
   */
  statusDetails?: {
    /** Error message associated with the inactive status. */
    errorMessage: string;
  };
}

export interface PaymentMethodDomainProps {
  /**
   * Domain name this payment method domain represents (e.g.
   * `"checkout.example.com"`). If omitted, a unique hostname is generated
   * from the stack, stage, and logical id under `.example.com`. Create-only
   * — changing it replaces the domain. Stripe domain names are unique per
   * account, including disabled domains.
   */
  domainName?: string;
  /**
   * Whether this payment method domain is enabled. If disabled, payment
   * methods that require a registered domain do not appear in Elements or
   * Embedded Checkout. Destroy sets this to `false`.
   * @default true
   */
  enabled?: boolean;
}

export type PaymentMethodDomain = Resource<
  "Stripe.PaymentMethodDomain",
  PaymentMethodDomainProps,
  {
    /** Stripe payment method domain id (`pmd_…`). */
    id: string;
    /** Domain name this object represents. */
    domainName: string;
    /** Whether this payment method domain is enabled. */
    enabled: boolean;
    /** Amazon Pay eligibility on this domain. */
    amazonPay: PaymentMethodDomainPaymentMethodStatus;
    /** Apple Pay eligibility on this domain. */
    applePay: PaymentMethodDomainPaymentMethodStatus;
    /** Google Pay eligibility on this domain. */
    googlePay: PaymentMethodDomainPaymentMethodStatus;
    /** Klarna eligibility on this domain. */
    klarna: PaymentMethodDomainPaymentMethodStatus;
    /** Link eligibility on this domain. */
    link: PaymentMethodDomainPaymentMethodStatus;
    /** PayPal eligibility on this domain. */
    paypal: PaymentMethodDomainPaymentMethodStatus;
    /** Unix timestamp when the domain was created. */
    created: number;
    /** Whether the domain exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Payment Method Domain — a web domain registered so Stripe
 * Elements and Embedded Checkout can show domain-gated payment methods
 * (Apple Pay, Google Pay, Link, PayPal, Klarna, Amazon Pay). `enabled`
 * updates in place. `domainName` is create-only and changing it replaces
 * the domain.
 *
 * Payment method domains have no metadata field and cannot be
 * hard-deleted. Destroying this resource disables it (`enabled: false`).
 * Disabled domains still occupy their `domainName`, so a later deploy
 * with the same name re-enables the existing domain.
 *
 * @see https://docs.stripe.com/api/payment_method_domains
 *
 * ### Creating a Domain
 * **Example:** Generated domain name
 * ```typescript
 * const domain = yield* Stripe.PaymentMethodDomain("checkout");
 * ```
 *
 * **Example:** Named domain
 * ```typescript
 * const domain = yield* Stripe.PaymentMethodDomain("checkout", {
 *   domainName: "checkout.example.com",
 * });
 * ```
 *
 * ### Updating a Domain
 * **Example:** Disable without replacing
 * ```typescript
 * const domain = yield* Stripe.PaymentMethodDomain("checkout", {
 *   domainName: "checkout.example.com",
 *   enabled: false,
 * });
 * ```
 *
 * ### Deactivating a Domain
 * **Example:** Destroy disables rather than deleting
 * ```typescript
 * // stack.destroy() / resource removal sets enabled: false
 * const domain = yield* Stripe.PaymentMethodDomain("checkout", {
 *   domainName: "checkout.example.com",
 * });
 * ```
 *
 * @resource
 */
export const PaymentMethodDomain = Resource<PaymentMethodDomain>(
  "Stripe.PaymentMethodDomain",
);

export class PaymentMethodDomainNotResolved extends Data.TaggedError(
  "Stripe.PaymentMethodDomainNotResolved",
)<{
  domainName: string;
}> {}

type PaymentMethodDomainAttributes = PaymentMethodDomain["Attributes"];

const toDomainName = (
  id: string,
  domainName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      domainName ??
      existing ??
      `${yield* createPhysicalName({
        id,
        maxLength: DOMAIN_LABEL_MAX_LENGTH,
        lowercase: true,
      })}${DOMAIN_SUFFIX}`
    );
  });

const toPaymentMethodStatus = (
  value: PaymentMethodDomainResourcePaymentMethodStatus,
): PaymentMethodDomainPaymentMethodStatus => ({
  status: value.status,
  statusDetails:
    value.status_details === undefined
      ? undefined
      : { errorMessage: value.status_details.error_message },
});

const toAttrs = (
  domain: StripePaymentMethodDomain,
): PaymentMethodDomainAttributes => ({
  id: domain.id,
  domainName: domain.domain_name,
  enabled: domain.enabled,
  amazonPay: toPaymentMethodStatus(domain.amazon_pay),
  applePay: toPaymentMethodStatus(domain.apple_pay),
  googlePay: toPaymentMethodStatus(domain.google_pay),
  klarna: toPaymentMethodStatus(domain.klarna),
  link: toPaymentMethodStatus(domain.link),
  paypal: toPaymentMethodStatus(domain.paypal),
  created: domain.created,
  livemode: domain.livemode,
});

const isMissingDomain = isMissingStripeResource;

const getById = (paymentMethodDomain: string) =>
  GetPaymentMethodDomain({
    payment_method_domain: paymentMethodDomain,
  }).pipe(Effect.catchIf(isMissingDomain, () => Effect.succeed(undefined)));

const listByEnabled = Effect.fn(function* (
  enabled: boolean,
  domainName?: string,
) {
  const domains: StripePaymentMethodDomain[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetPaymentMethodDomains({
      enabled,
      limit: LIST_PAGE_SIZE,
      ...(domainName !== undefined ? { domain_name: domainName } : {}),
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    domains.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return domains;
});

const findByDomainName = Effect.fn(function* (domainName: string) {
  const [enabled, disabled] = yield* Effect.all(
    [listByEnabled(true, domainName), listByEnabled(false, domainName)],
    { concurrency: 2 },
  );
  const matches = [...enabled, ...disabled].filter(
    (domain) => domain.domain_name === domainName,
  );
  return matches.find((domain) => domain.enabled) ?? matches[0];
});

const observe = Effect.fn(function* (input: {
  id?: string;
  domainName?: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  if (input.domainName !== undefined) {
    return yield* findByDomainName(input.domainName);
  }
  return undefined;
});

const shouldReplace = (
  news: PaymentMethodDomainProps,
  output: PaymentMethodDomainAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.domainName !== undefined && news.domainName !== output.domainName) {
    return true;
  }
  return false;
};

export const PaymentMethodDomainProvider = () =>
  Provider.succeed(PaymentMethodDomain, {
    stables: ["id", "domainName", "created", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const existing = yield* observe({
        id: output?.id,
        domainName: output?.domainName,
      });
      if (existing === undefined) return undefined;
      // Payment method domains have no metadata. Identity is the Stripe
      // id and the unique domain_name; a match is treated as owned.
      return toAttrs(existing);
    }),

    list: Effect.fn(function* () {
      // No metadata on this resource. Default list is enabled domains;
      // disabled rows stay in Stripe (domain_name remains reserved) but
      // must not re-enter nuke.
      const domains = yield* listByEnabled(true);
      return domains.map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const domainName = yield* toDomainName(
        id,
        news.domainName,
        output?.domainName,
      );
      const desiredEnabled = news.enabled ?? true;

      let current = yield* observe({
        id: output?.id,
        domainName,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreatePaymentMethodDomain({
          domain_name: domainName,
          enabled: desiredEnabled,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-payment-method-domain-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new PaymentMethodDomainNotResolved({ domainName });
      }

      if (current.enabled === desiredEnabled) {
        return toAttrs(current);
      }

      const updated = yield* UpdatePaymentMethodDomain({
        payment_method_domain: current.id,
        enabled: desiredEnabled,
      });
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || !existing.enabled) return;
      yield* UpdatePaymentMethodDomain({
        payment_method_domain: existing.id,
        enabled: false,
      }).pipe(Effect.catchIf(isMissingDomain, () => Effect.void));
    }),
  });
