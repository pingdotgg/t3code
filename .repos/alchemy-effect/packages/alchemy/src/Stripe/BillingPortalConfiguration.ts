import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetBillingPortalConfigurations,
  GetBillingPortalConfiguration,
  CreateBillingPortalConfiguration,
  UpdateBillingPortalConfiguration,
  type BillingPortalConfiguration as StripeBillingPortalConfiguration,
  type PortalFeatures,
  type CreateBillingPortalConfigurationRequestFeatures,
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

export type CustomerUpdateAllowedUpdate =
  | "address"
  | "email"
  | "name"
  | "phone"
  | "shipping"
  | "tax_id";

export type SubscriptionCancelMode = "at_period_end" | "immediately";

export type SubscriptionCancelProrationBehavior =
  | "always_invoice"
  | "create_prorations"
  | "none";

export type CancellationReasonOption =
  | "customer_service"
  | "low_quality"
  | "missing_features"
  | "other"
  | "switched_service"
  | "too_complex"
  | "too_expensive"
  | "unused";

export type SubscriptionUpdateAllowedUpdate =
  | "price"
  | "promotion_code"
  | "quantity";

export type SubscriptionUpdateBillingCycleAnchor = "now" | "unchanged";

export type SubscriptionUpdateProrationBehavior =
  | "always_invoice"
  | "create_prorations"
  | "none";

export type SubscriptionUpdateTrialBehavior = "continue_trial" | "end_trial";

export type ScheduleAtPeriodEndConditionType =
  | "decreasing_item_amount"
  | "shortening_interval";

export interface BillingPortalCustomerUpdate {
  /**
   * Whether customers can update their details in the portal.
   */
  enabled: boolean;
  /**
   * Customer fields that can be updated. Empty means none are updateable.
   */
  allowedUpdates?: CustomerUpdateAllowedUpdate[];
}

export interface BillingPortalInvoiceHistory {
  /**
   * Whether the portal shows invoice history.
   */
  enabled: boolean;
}

export interface BillingPortalPaymentMethodUpdate {
  /**
   * Whether customers can update payment methods in the portal.
   */
  enabled: boolean;
  /**
   * Payment Method Configuration id to use. When omitted, Stripe uses the
   * default configuration.
   */
  paymentMethodConfiguration?: string;
}

export interface BillingPortalCancellationReason {
  /**
   * Whether cancellation reasons are collected in the portal.
   */
  enabled: boolean;
  /**
   * Cancellation reasons shown to the customer.
   */
  options?: CancellationReasonOption[];
}

export interface BillingPortalSubscriptionCancel {
  /**
   * Whether customers can cancel subscriptions in the portal.
   */
  enabled: boolean;
  /**
   * When to cancel: immediately or at period end.
   */
  mode?: SubscriptionCancelMode;
  /**
   * Proration behavior when canceling. `create_prorations` is only valid
   * with `mode: "immediately"`.
   */
  prorationBehavior?: SubscriptionCancelProrationBehavior;
  /**
   * Cancellation-reason collection in the portal.
   */
  cancellationReason?: BillingPortalCancellationReason;
}

export interface BillingPortalAdjustableQuantity {
  /**
   * Whether quantity can be adjusted to any non-negative integer.
   */
  enabled: boolean;
  /**
   * Maximum quantity that can be set.
   */
  maximum?: number;
  /**
   * Minimum quantity that can be set.
   */
  minimum?: number;
}

export interface BillingPortalSubscriptionUpdateProduct {
  /**
   * Product id customers can switch to.
   */
  product: string;
  /**
   * Price ids for this product that a subscription can be updated to.
   */
  prices: string[];
  /**
   * Quantity-adjustment controls for this product.
   */
  adjustableQuantity?: BillingPortalAdjustableQuantity;
}

export interface BillingPortalScheduleAtPeriodEnd {
  /**
   * Conditions that schedule an update for the end of the current period.
   */
  conditions?: { type: ScheduleAtPeriodEndConditionType }[];
}

export interface BillingPortalSubscriptionUpdate {
  /**
   * Whether customers can update subscriptions in the portal.
   */
  enabled: boolean;
  /**
   * Billing cycle anchor after an update (`now` or `unchanged`).
   */
  billingCycleAnchor?: SubscriptionUpdateBillingCycleAnchor;
  /**
   * Subscription fields customers may change for listed products.
   */
  defaultAllowedUpdates?: SubscriptionUpdateAllowedUpdate[];
  /**
   * Up to 10 products that support subscription updates. Required when
   * the feature is enabled.
   */
  products?: BillingPortalSubscriptionUpdateProduct[];
  /**
   * How to handle prorations from subscription updates.
   */
  prorationBehavior?: SubscriptionUpdateProrationBehavior;
  /**
   * When to apply an update at period end instead of immediately.
   */
  scheduleAtPeriodEnd?: BillingPortalScheduleAtPeriodEnd;
  /**
   * How to handle updates to a trialing subscription.
   */
  trialUpdateBehavior?: SubscriptionUpdateTrialBehavior;
}

export interface BillingPortalFeatures {
  /**
   * Customer-details updates in the portal.
   */
  customerUpdate?: BillingPortalCustomerUpdate;
  /**
   * Invoice history in the portal.
   */
  invoiceHistory?: BillingPortalInvoiceHistory;
  /**
   * Payment-method updates in the portal.
   */
  paymentMethodUpdate?: BillingPortalPaymentMethodUpdate;
  /**
   * Subscription cancellation in the portal.
   */
  subscriptionCancel?: BillingPortalSubscriptionCancel;
  /**
   * Subscription updates in the portal.
   */
  subscriptionUpdate?: BillingPortalSubscriptionUpdate;
}

export interface BillingPortalBusinessProfile {
  /**
   * Messaging shown to customers in the portal.
   */
  headline?: string;
  /**
   * Public privacy-policy URL.
   */
  privacyPolicyUrl?: string;
  /**
   * Public terms-of-service URL.
   */
  termsOfServiceUrl?: string;
}

export interface BillingPortalLoginPage {
  /**
   * When true, Stripe generates a shareable hosted login URL.
   */
  enabled: boolean;
}

export interface BillingPortalConfigurationProps {
  /**
   * Display name of the configuration.
   */
  name?: string;
  /**
   * Whether the configuration can be used to create portal sessions.
   * New configurations are created active. Destroy sets this to `false`.
   * @default true
   */
  active?: boolean;
  /**
   * Default URL customers return to from the portal. Empty string clears
   * it on update.
   */
  defaultReturnUrl?: string;
  /**
   * Business information shown in the portal.
   */
  businessProfile?: BillingPortalBusinessProfile;
  /**
   * Features available in the portal. Required on create.
   */
  features: BillingPortalFeatures;
  /**
   * Hosted login page for this configuration.
   */
  loginPage?: BillingPortalLoginPage;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`.
   */
  metadata?: Record<string, string>;
}

export interface BillingPortalFeaturesState {
  /** Customer-details updates currently configured. */
  customerUpdate: {
    enabled: boolean;
    allowedUpdates: CustomerUpdateAllowedUpdate[];
  };
  /** Invoice history currently configured. */
  invoiceHistory: { enabled: boolean };
  /** Payment-method updates currently configured. */
  paymentMethodUpdate: {
    enabled: boolean;
    paymentMethodConfiguration: string | undefined;
  };
  /** Subscription cancellation currently configured. */
  subscriptionCancel: {
    enabled: boolean;
    mode: SubscriptionCancelMode;
    prorationBehavior: SubscriptionCancelProrationBehavior;
    cancellationReason: {
      enabled: boolean;
      options: CancellationReasonOption[];
    };
  };
  /** Subscription updates currently configured. */
  subscriptionUpdate: {
    enabled: boolean;
    billingCycleAnchor: SubscriptionUpdateBillingCycleAnchor | undefined;
    defaultAllowedUpdates: SubscriptionUpdateAllowedUpdate[];
    products: BillingPortalSubscriptionUpdateProduct[] | undefined;
    prorationBehavior: SubscriptionUpdateProrationBehavior;
    scheduleAtPeriodEnd: {
      conditions: { type: ScheduleAtPeriodEndConditionType }[];
    };
    trialUpdateBehavior: SubscriptionUpdateTrialBehavior;
  };
}

export type BillingPortalConfiguration = Resource<
  "Stripe.BillingPortalConfiguration",
  BillingPortalConfigurationProps,
  {
    /** Stripe billing portal configuration id (`bpc_…`). */
    id: string;
    /** Display name of the configuration, if set. */
    name: string | undefined;
    /** Whether the configuration can create portal sessions. */
    active: boolean;
    /** Whether this is the account's default configuration. */
    isDefault: boolean;
    /** Default return URL, if set. */
    defaultReturnUrl: string | undefined;
    /** Business information shown in the portal. */
    businessProfile: {
      headline: string | undefined;
      privacyPolicyUrl: string | undefined;
      termsOfServiceUrl: string | undefined;
    };
    /** Features currently configured on the portal. */
    features: BillingPortalFeaturesState;
    /** Hosted login page (`url` is set when enabled). */
    loginPage: { enabled: boolean; url: string | undefined };
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the configuration was created. */
    created: number;
    /** Unix timestamp when the configuration was last updated. */
    updated: number;
    /** Whether the configuration exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Customer Portal configuration — the features, branding, and
 * return URL used when creating portal sessions. `features` is required
 * on create. Name, metadata, business profile, login page, return URL,
 * features, and `active` update in place. Stripe does not hard-delete
 * portal configurations; destroying this resource deactivates it
 * (`active: false`).
 *
 * @see https://docs.stripe.com/api/customer_portal/configurations
 *
 * ### Creating a Configuration
 * **Example:** Invoice history only
 * ```typescript
 * const portal = yield* Stripe.BillingPortalConfiguration("customer-portal", {
 *   name: "Customer portal",
 *   features: {
 *     invoiceHistory: { enabled: true },
 *   },
 * });
 * ```
 *
 * **Example:** Customer updates and payment methods
 * ```typescript
 * const portal = yield* Stripe.BillingPortalConfiguration("customer-portal", {
 *   name: "Customer portal",
 *   defaultReturnUrl: "https://example.com/account",
 *   features: {
 *     invoiceHistory: { enabled: true },
 *     customerUpdate: {
 *       enabled: true,
 *       allowedUpdates: ["email", "address"],
 *     },
 *     paymentMethodUpdate: { enabled: true },
 *   },
 *   metadata: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Configuration
 * **Example:** Rename, retag, and enable cancellation
 * ```typescript
 * const portal = yield* Stripe.BillingPortalConfiguration("customer-portal", {
 *   name: "Customer portal (updated)",
 *   features: {
 *     invoiceHistory: { enabled: true },
 *     subscriptionCancel: { enabled: true, mode: "at_period_end" },
 *   },
 *   metadata: { env: "prod", revision: "2" },
 * });
 * ```
 *
 * ### Deactivating a Configuration
 * **Example:** Destroy deactivates rather than deleting
 * ```typescript
 * // stack.destroy() / resource removal sets active: false
 * const portal = yield* Stripe.BillingPortalConfiguration("customer-portal", {
 *   features: { invoiceHistory: { enabled: true } },
 * });
 * ```
 *
 * @resource
 */
export const BillingPortalConfiguration = Resource<BillingPortalConfiguration>(
  "Stripe.BillingPortalConfiguration",
);

export class BillingPortalConfigurationNotResolved extends Data.TaggedError(
  "Stripe.BillingPortalConfigurationNotResolved",
)<{
  configurationId: string | undefined;
}> {}

type ConfigurationAttributes = BillingPortalConfiguration["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const fromObservedFeatures = (
  features: PortalFeatures,
): BillingPortalFeaturesState => ({
  customerUpdate: {
    enabled: features.customer_update.enabled,
    allowedUpdates: features.customer_update.allowed_updates,
  },
  invoiceHistory: { enabled: features.invoice_history.enabled },
  paymentMethodUpdate: {
    enabled: features.payment_method_update.enabled,
    paymentMethodConfiguration:
      features.payment_method_update.payment_method_configuration ?? undefined,
  },
  subscriptionCancel: {
    enabled: features.subscription_cancel.enabled,
    mode: features.subscription_cancel.mode,
    prorationBehavior: features.subscription_cancel.proration_behavior,
    cancellationReason: {
      enabled: features.subscription_cancel.cancellation_reason.enabled,
      options: features.subscription_cancel.cancellation_reason.options,
    },
  },
  subscriptionUpdate: {
    enabled: features.subscription_update.enabled,
    billingCycleAnchor:
      features.subscription_update.billing_cycle_anchor ?? undefined,
    defaultAllowedUpdates: features.subscription_update.default_allowed_updates,
    products:
      features.subscription_update.products?.map((product) => ({
        product: product.product,
        prices: product.prices,
        adjustableQuantity: {
          enabled: product.adjustable_quantity.enabled,
          maximum: product.adjustable_quantity.maximum ?? undefined,
          minimum: product.adjustable_quantity.minimum,
        },
      })) ?? undefined,
    prorationBehavior: features.subscription_update.proration_behavior,
    scheduleAtPeriodEnd: {
      conditions:
        features.subscription_update.schedule_at_period_end.conditions.map(
          (condition) => ({ type: condition.type }),
        ),
    },
    trialUpdateBehavior: features.subscription_update.trial_update_behavior,
  },
});

const toAttrs = (
  configuration: StripeBillingPortalConfiguration,
): ConfigurationAttributes => ({
  id: configuration.id,
  name: configuration.name ?? undefined,
  active: configuration.active,
  isDefault: configuration.is_default,
  defaultReturnUrl: configuration.default_return_url ?? undefined,
  businessProfile: {
    headline: configuration.business_profile.headline ?? undefined,
    privacyPolicyUrl:
      configuration.business_profile.privacy_policy_url ?? undefined,
    termsOfServiceUrl:
      configuration.business_profile.terms_of_service_url ?? undefined,
  },
  features: fromObservedFeatures(configuration.features),
  loginPage: {
    enabled: configuration.login_page.enabled,
    url: configuration.login_page.url ?? undefined,
  },
  metadata: userMetadata(configuration.metadata),
  created: configuration.created,
  updated: configuration.updated,
  livemode: configuration.livemode,
});

const emptyOrList = <T>(value: T[] | undefined): T[] | "" | undefined => {
  if (value === undefined) return undefined;
  return value.length === 0 ? "" : value;
};

const toWireFeatures = (
  features: BillingPortalFeatures,
): CreateBillingPortalConfigurationRequestFeatures => ({
  ...(features.customerUpdate !== undefined
    ? {
        customer_update: {
          enabled: features.customerUpdate.enabled,
          ...(features.customerUpdate.allowedUpdates !== undefined
            ? {
                allowed_updates: emptyOrList(
                  features.customerUpdate.allowedUpdates,
                ),
              }
            : {}),
        },
      }
    : {}),
  ...(features.invoiceHistory !== undefined
    ? { invoice_history: { enabled: features.invoiceHistory.enabled } }
    : {}),
  ...(features.paymentMethodUpdate !== undefined
    ? {
        payment_method_update: {
          enabled: features.paymentMethodUpdate.enabled,
          ...(features.paymentMethodUpdate.paymentMethodConfiguration !==
          undefined
            ? {
                payment_method_configuration:
                  features.paymentMethodUpdate.paymentMethodConfiguration,
              }
            : {}),
        },
      }
    : {}),
  ...(features.subscriptionCancel !== undefined
    ? {
        subscription_cancel: {
          enabled: features.subscriptionCancel.enabled,
          ...(features.subscriptionCancel.mode !== undefined
            ? { mode: features.subscriptionCancel.mode }
            : {}),
          ...(features.subscriptionCancel.prorationBehavior !== undefined
            ? {
                proration_behavior:
                  features.subscriptionCancel.prorationBehavior,
              }
            : {}),
          ...(features.subscriptionCancel.cancellationReason !== undefined
            ? {
                cancellation_reason: {
                  enabled:
                    features.subscriptionCancel.cancellationReason.enabled,
                  options:
                    emptyOrList(
                      features.subscriptionCancel.cancellationReason.options,
                    ) ?? "",
                },
              }
            : {}),
        },
      }
    : {}),
  ...(features.subscriptionUpdate !== undefined
    ? {
        subscription_update: {
          enabled: features.subscriptionUpdate.enabled,
          ...(features.subscriptionUpdate.billingCycleAnchor !== undefined
            ? {
                billing_cycle_anchor:
                  features.subscriptionUpdate.billingCycleAnchor,
              }
            : {}),
          ...(features.subscriptionUpdate.defaultAllowedUpdates !== undefined
            ? {
                default_allowed_updates: emptyOrList(
                  features.subscriptionUpdate.defaultAllowedUpdates,
                ),
              }
            : {}),
          ...(features.subscriptionUpdate.products !== undefined
            ? {
                products:
                  features.subscriptionUpdate.products.length === 0
                    ? ""
                    : features.subscriptionUpdate.products.map((product) => ({
                        product: product.product,
                        prices: product.prices,
                        ...(product.adjustableQuantity !== undefined
                          ? {
                              adjustable_quantity: {
                                enabled: product.adjustableQuantity.enabled,
                                ...(product.adjustableQuantity.maximum !==
                                undefined
                                  ? {
                                      maximum:
                                        product.adjustableQuantity.maximum,
                                    }
                                  : {}),
                                ...(product.adjustableQuantity.minimum !==
                                undefined
                                  ? {
                                      minimum:
                                        product.adjustableQuantity.minimum,
                                    }
                                  : {}),
                              },
                            }
                          : {}),
                      })),
              }
            : {}),
          ...(features.subscriptionUpdate.prorationBehavior !== undefined
            ? {
                proration_behavior:
                  features.subscriptionUpdate.prorationBehavior,
              }
            : {}),
          ...(features.subscriptionUpdate.scheduleAtPeriodEnd !== undefined
            ? {
                schedule_at_period_end: {
                  ...(features.subscriptionUpdate.scheduleAtPeriodEnd
                    .conditions !== undefined
                    ? {
                        conditions:
                          features.subscriptionUpdate.scheduleAtPeriodEnd
                            .conditions,
                      }
                    : {}),
                },
              }
            : {}),
          ...(features.subscriptionUpdate.trialUpdateBehavior !== undefined
            ? {
                trial_update_behavior:
                  features.subscriptionUpdate.trialUpdateBehavior,
              }
            : {}),
        },
      }
    : {}),
});

const pickSpecified = (desired: unknown, observed: unknown): unknown => {
  if (desired === undefined) return undefined;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed)) return observed;
    return desired.map((item, index) => pickSpecified(item, observed[index]));
  }
  if (
    desired !== null &&
    typeof desired === "object" &&
    observed !== null &&
    typeof observed === "object"
  ) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(desired as Record<string, unknown>)) {
      out[key] = pickSpecified(
        (desired as Record<string, unknown>)[key],
        (observed as Record<string, unknown>)[key],
      );
    }
    return out;
  }
  return observed;
};

const featuresNeedSync = (
  desired: BillingPortalFeatures,
  observed: BillingPortalFeaturesState,
): boolean =>
  !deepEqual(desired, pickSpecified(desired, observed), {
    stripNullish: true,
  });

const businessProfileNeedSync = (
  desired: BillingPortalBusinessProfile | undefined,
  observed: ConfigurationAttributes["businessProfile"],
): boolean => {
  if (desired === undefined) return false;
  return !deepEqual(desired, pickSpecified(desired, observed), {
    stripNullish: true,
  });
};

const toWireBusinessProfile = (profile: BillingPortalBusinessProfile) => ({
  ...(profile.headline !== undefined ? { headline: profile.headline } : {}),
  ...(profile.privacyPolicyUrl !== undefined
    ? { privacy_policy_url: profile.privacyPolicyUrl }
    : {}),
  ...(profile.termsOfServiceUrl !== undefined
    ? { terms_of_service_url: profile.termsOfServiceUrl }
    : {}),
});

const isMissingConfiguration = isMissingStripeResource;

const getById = (configuration: string) =>
  GetBillingPortalConfiguration({ configuration }).pipe(
    Effect.catchIf(isMissingConfiguration, () => Effect.succeed(undefined)),
  );

const listByActive = Effect.fn(function* (active: boolean) {
  const configurations: StripeBillingPortalConfiguration[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetBillingPortalConfigurations({
      active,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    configurations.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return configurations;
});

const listAllConfigurations = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all(
    [listByActive(true), listByActive(false)],
    { concurrency: 2 },
  );
  const seen = new Set<string>();
  const configurations: StripeBillingPortalConfiguration[] = [];
  for (const configuration of [...active, ...inactive]) {
    if (seen.has(configuration.id)) continue;
    seen.add(configuration.id);
    configurations.push(configuration);
  }
  return configurations;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const configurations = yield* listAllConfigurations();
  const matches: StripeBillingPortalConfiguration[] = [];
  for (const configuration of configurations) {
    if (yield* hasAlchemyMetadata(id, tagRecord(configuration.metadata))) {
      matches.push(configuration);
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

export const BillingPortalConfigurationProvider = () =>
  Provider.succeed(BillingPortalConfiguration, {
    stables: ["id", "created", "livemode", "isDefault"],

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
      const configurations = yield* listAllConfigurations();
      return configurations
        .filter((configuration) => {
          const metadata = tagRecord(configuration.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredActive = news.active ?? true;
      const wireFeatures = toWireFeatures(news.features);

      let current = yield* observe({
        id: output?.id,
        logicalId: id,
      });

      if (current === undefined) {
        current = yield* CreateBillingPortalConfiguration({
          features: wireFeatures,
          metadata,
          ...(news.name !== undefined ? { name: news.name } : {}),
          ...(news.defaultReturnUrl !== undefined
            ? { default_return_url: news.defaultReturnUrl }
            : {}),
          ...(news.businessProfile !== undefined
            ? { business_profile: toWireBusinessProfile(news.businessProfile) }
            : {}),
          ...(news.loginPage !== undefined
            ? { login_page: { enabled: news.loginPage.enabled } }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-billing-portal-configuration-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new BillingPortalConfigurationNotResolved({
          configurationId: output?.id,
        });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const attrs = toAttrs(current);
      const activeChanged = current.active !== desiredActive;
      const nameChanged =
        news.name !== undefined && (current.name ?? "") !== news.name;
      const defaultReturnUrlChanged =
        news.defaultReturnUrl !== undefined &&
        (current.default_return_url ?? "") !== news.defaultReturnUrl;
      const loginPageChanged =
        news.loginPage !== undefined &&
        current.login_page.enabled !== news.loginPage.enabled;
      const featuresChanged = featuresNeedSync(news.features, attrs.features);
      const businessProfileChanged = businessProfileNeedSync(
        news.businessProfile,
        attrs.businessProfile,
      );

      if (
        !activeChanged &&
        !nameChanged &&
        !defaultReturnUrlChanged &&
        !loginPageChanged &&
        !featuresChanged &&
        !businessProfileChanged &&
        !metadataChanged
      ) {
        return attrs;
      }

      const updated = yield* UpdateBillingPortalConfiguration({
        configuration: current.id,
        ...(activeChanged ? { active: desiredActive } : {}),
        ...(nameChanged ? { name: news.name } : {}),
        ...(defaultReturnUrlChanged
          ? { default_return_url: news.defaultReturnUrl }
          : {}),
        ...(loginPageChanged && news.loginPage !== undefined
          ? { login_page: { enabled: news.loginPage.enabled } }
          : {}),
        ...(featuresChanged ? { features: wireFeatures } : {}),
        ...(businessProfileChanged && news.businessProfile !== undefined
          ? { business_profile: toWireBusinessProfile(news.businessProfile) }
          : {}),
        ...(metadataChanged
          ? {
              metadata: {
                ...Object.fromEntries(removed.map((key) => [key, ""])),
                ...metadata,
              },
            }
          : {}),
      });
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || !existing.active) return;
      yield* UpdateBillingPortalConfiguration({
        configuration: existing.id,
        active: false,
      }).pipe(Effect.catchIf(isMissingConfiguration, () => Effect.void));
    }),
  });
