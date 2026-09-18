import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetPaymentMethodConfigurations,
  GetPaymentMethodConfiguration,
  CreatePaymentMethodConfiguration,
  UpdatePaymentMethodConfiguration,
  type PaymentMethodConfigResourcePaymentMethodProperties,
  type PaymentMethodConfiguration as StripePaymentMethodConfiguration,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const NAME_MAX_LENGTH = 100;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** Account preference for whether a payment method is displayed. */
export type PaymentMethodPreference = "none" | "off" | "on";

/** Effective display value after parent/override resolution. */
export type PaymentMethodEffectivePreference = "off" | "on";

export interface PaymentMethodDisplayPreference {
  /**
   * Account preference for whether this payment method is displayed at
   * checkout. `on` shows it, `off` hides it, `none` defers to the parent
   * configuration or Stripe's default.
   */
  preference?: PaymentMethodPreference;
}

export interface PaymentMethodPreferenceInput {
  /**
   * Whether or not the payment method should be displayed at checkout.
   */
  displayPreference?: PaymentMethodDisplayPreference;
}

export interface PaymentMethodState {
  /**
   * Whether this payment method may be offered at checkout. True when
   * `displayPreference` is `on` and the payment method's capability is
   * active.
   */
  available: boolean;
  /**
   * Observed display preference, including the effective value.
   */
  displayPreference: {
    /**
     * For child configs, whether the connected account may override.
     */
    overridable: boolean | undefined;
    /**
     * Configured preference (`on` / `off` / `none`).
     */
    preference: PaymentMethodPreference;
    /**
     * Effective display value after parent/override resolution.
     */
    value: PaymentMethodEffectivePreference;
  };
}

export interface PaymentMethodConfigurationProps {
  /**
   * Configuration name. If omitted, a unique name is generated from the
   * stack, stage, and logical id. Mutable. Max 100 characters. Used as
   * the lookup key when the Stripe id is missing — this object has no
   * metadata.
   */
  name?: string;
  /**
   * Whether the configuration can be used for new payments. New
   * configurations are created active. Destroy sets this to `false`.
   * @default true
   */
  active?: boolean;
  /**
   * Parent configuration id. Specify to create a child configuration for
   * a connected account. Create-only — changing it replaces the
   * configuration.
   */
  parent?: string;
  /** Display preference for ACSS Debit. */
  acssDebit?: PaymentMethodPreferenceInput;
  /** Display preference for Affirm. */
  affirm?: PaymentMethodPreferenceInput;
  /** Display preference for Afterpay / Clearpay. */
  afterpayClearpay?: PaymentMethodPreferenceInput;
  /** Display preference for Alipay. */
  alipay?: PaymentMethodPreferenceInput;
  /** Display preference for Alma. */
  alma?: PaymentMethodPreferenceInput;
  /** Display preference for Amazon Pay. */
  amazonPay?: PaymentMethodPreferenceInput;
  /** Display preference for Apple Pay. */
  applePay?: PaymentMethodPreferenceInput;
  /** Display preference for AU BECS Debit. */
  auBecsDebit?: PaymentMethodPreferenceInput;
  /** Display preference for Bacs Direct Debit. */
  bacsDebit?: PaymentMethodPreferenceInput;
  /** Display preference for Bancontact. */
  bancontact?: PaymentMethodPreferenceInput;
  /** Display preference for Billie. */
  billie?: PaymentMethodPreferenceInput;
  /** Display preference for Bizum. */
  bizum?: PaymentMethodPreferenceInput;
  /** Display preference for BLIK. */
  blik?: PaymentMethodPreferenceInput;
  /** Display preference for Boleto. */
  boleto?: PaymentMethodPreferenceInput;
  /** Display preference for cards. */
  card?: PaymentMethodPreferenceInput;
  /** Display preference for Cartes Bancaires. */
  cartesBancaires?: PaymentMethodPreferenceInput;
  /** Display preference for Cash App Pay. */
  cashapp?: PaymentMethodPreferenceInput;
  /** Display preference for crypto / stablecoin payments. */
  crypto?: PaymentMethodPreferenceInput;
  /** Display preference for customer balance (bank transfer). */
  customerBalance?: PaymentMethodPreferenceInput;
  /** Display preference for EPS. */
  eps?: PaymentMethodPreferenceInput;
  /** Display preference for FPX. */
  fpx?: PaymentMethodPreferenceInput;
  /** Display preference for giropay. */
  giropay?: PaymentMethodPreferenceInput;
  /** Display preference for Google Pay. */
  googlePay?: PaymentMethodPreferenceInput;
  /** Display preference for GrabPay. */
  grabpay?: PaymentMethodPreferenceInput;
  /** Display preference for iDEAL. */
  ideal?: PaymentMethodPreferenceInput;
  /** Display preference for JCB. */
  jcb?: PaymentMethodPreferenceInput;
  /** Display preference for Kakao Pay. */
  kakaoPay?: PaymentMethodPreferenceInput;
  /** Display preference for Klarna. */
  klarna?: PaymentMethodPreferenceInput;
  /** Display preference for Konbini. */
  konbini?: PaymentMethodPreferenceInput;
  /** Display preference for Korean cards. */
  krCard?: PaymentMethodPreferenceInput;
  /** Display preference for Link. */
  link?: PaymentMethodPreferenceInput;
  /** Display preference for MB WAY. */
  mbWay?: PaymentMethodPreferenceInput;
  /** Display preference for MobilePay. */
  mobilepay?: PaymentMethodPreferenceInput;
  /** Display preference for Multibanco. */
  multibanco?: PaymentMethodPreferenceInput;
  /** Display preference for Naver Pay. */
  naverPay?: PaymentMethodPreferenceInput;
  /** Display preference for NZ BECS Debit. */
  nzBankAccount?: PaymentMethodPreferenceInput;
  /** Display preference for OXXO. */
  oxxo?: PaymentMethodPreferenceInput;
  /** Display preference for Przelewy24. */
  p24?: PaymentMethodPreferenceInput;
  /** Display preference for Pay by Bank. */
  payByBank?: PaymentMethodPreferenceInput;
  /** Display preference for PAYCO. */
  payco?: PaymentMethodPreferenceInput;
  /** Display preference for PayNow. */
  paynow?: PaymentMethodPreferenceInput;
  /** Display preference for PayPal. */
  paypal?: PaymentMethodPreferenceInput;
  /** Display preference for PayTo. */
  payto?: PaymentMethodPreferenceInput;
  /** Display preference for Pix. */
  pix?: PaymentMethodPreferenceInput;
  /** Display preference for PromptPay. */
  promptpay?: PaymentMethodPreferenceInput;
  /** Display preference for Revolut Pay. */
  revolutPay?: PaymentMethodPreferenceInput;
  /** Display preference for Samsung Pay. */
  samsungPay?: PaymentMethodPreferenceInput;
  /** Display preference for Satispay. */
  satispay?: PaymentMethodPreferenceInput;
  /** Display preference for Scalapay. */
  scalapay?: PaymentMethodPreferenceInput;
  /** Display preference for SEPA Debit. */
  sepaDebit?: PaymentMethodPreferenceInput;
  /** Display preference for Sofort. */
  sofort?: PaymentMethodPreferenceInput;
  /** Display preference for Sunbit. */
  sunbit?: PaymentMethodPreferenceInput;
  /** Display preference for Swish. */
  swish?: PaymentMethodPreferenceInput;
  /** Display preference for Twint. */
  twint?: PaymentMethodPreferenceInput;
  /** Display preference for UPI. */
  upi?: PaymentMethodPreferenceInput;
  /** Display preference for US bank account (ACH). */
  usBankAccount?: PaymentMethodPreferenceInput;
  /** Display preference for WeChat Pay. */
  wechatPay?: PaymentMethodPreferenceInput;
  /** Display preference for Zip. */
  zip?: PaymentMethodPreferenceInput;
}

type MethodKey = Exclude<
  keyof PaymentMethodConfigurationProps,
  "name" | "active" | "parent"
>;

type SnakeMethodKey = (typeof METHOD_MAP)[number][1];

const METHOD_MAP = [
  ["acssDebit", "acss_debit"],
  ["affirm", "affirm"],
  ["afterpayClearpay", "afterpay_clearpay"],
  ["alipay", "alipay"],
  ["alma", "alma"],
  ["amazonPay", "amazon_pay"],
  ["applePay", "apple_pay"],
  ["auBecsDebit", "au_becs_debit"],
  ["bacsDebit", "bacs_debit"],
  ["bancontact", "bancontact"],
  ["billie", "billie"],
  ["bizum", "bizum"],
  ["blik", "blik"],
  ["boleto", "boleto"],
  ["card", "card"],
  ["cartesBancaires", "cartes_bancaires"],
  ["cashapp", "cashapp"],
  ["crypto", "crypto"],
  ["customerBalance", "customer_balance"],
  ["eps", "eps"],
  ["fpx", "fpx"],
  ["giropay", "giropay"],
  ["googlePay", "google_pay"],
  ["grabpay", "grabpay"],
  ["ideal", "ideal"],
  ["jcb", "jcb"],
  ["kakaoPay", "kakao_pay"],
  ["klarna", "klarna"],
  ["konbini", "konbini"],
  ["krCard", "kr_card"],
  ["link", "link"],
  ["mbWay", "mb_way"],
  ["mobilepay", "mobilepay"],
  ["multibanco", "multibanco"],
  ["naverPay", "naver_pay"],
  ["nzBankAccount", "nz_bank_account"],
  ["oxxo", "oxxo"],
  ["p24", "p24"],
  ["payByBank", "pay_by_bank"],
  ["payco", "payco"],
  ["paynow", "paynow"],
  ["paypal", "paypal"],
  ["payto", "payto"],
  ["pix", "pix"],
  ["promptpay", "promptpay"],
  ["revolutPay", "revolut_pay"],
  ["samsungPay", "samsung_pay"],
  ["satispay", "satispay"],
  ["scalapay", "scalapay"],
  ["sepaDebit", "sepa_debit"],
  ["sofort", "sofort"],
  ["sunbit", "sunbit"],
  ["swish", "swish"],
  ["twint", "twint"],
  ["upi", "upi"],
  ["usBankAccount", "us_bank_account"],
  ["wechatPay", "wechat_pay"],
  ["zip", "zip"],
] as const satisfies ReadonlyArray<readonly [MethodKey, string]>;

type PaymentMethodAttributes = {
  [K in MethodKey]: PaymentMethodState | undefined;
};

export type PaymentMethodConfiguration = Resource<
  "Stripe.PaymentMethodConfiguration",
  PaymentMethodConfigurationProps,
  {
    /** Stripe payment method configuration id (`pmc_…`). */
    id: string;
    /** Configuration name. */
    name: string;
    /** Whether the configuration can be used for new payments. */
    active: boolean;
    /** Whether this is the account's default configuration. */
    isDefault: boolean;
    /** Parent configuration id, if this is a child config. */
    parent: string | undefined;
    /** Connect application id for child configs, if any. */
    application: string | undefined;
    /** Whether the configuration exists in live mode. */
    livemode: boolean;
  } & PaymentMethodAttributes,
  never,
  Providers
>;

/**
 * A Stripe Payment Method Configuration — which payment methods Checkout,
 * PaymentIntents, and SetupIntents show when payment method types are not
 * set explicitly. `name` and per-method `displayPreference` update in
 * place. `parent` is create-only and changing it replaces the
 * configuration.
 *
 * Payment method configurations have no metadata field and cannot be
 * hard-deleted. Destroying this resource deactivates it (`active: false`).
 * Identity is the Stripe id plus the unique name.
 *
 * @see https://docs.stripe.com/api/payment_method_configurations
 *
 * ### Creating a Configuration
 * **Example:** Named checkout configuration
 * ```typescript
 * const checkout = yield* Stripe.PaymentMethodConfiguration("checkout", {
 *   name: "Checkout",
 *   card: { displayPreference: { preference: "on" } },
 *   link: { displayPreference: { preference: "on" } },
 * });
 * ```
 *
 * **Example:** Cards only
 * ```typescript
 * const cards = yield* Stripe.PaymentMethodConfiguration("cards", {
 *   name: "Cards only",
 *   card: { displayPreference: { preference: "on" } },
 *   link: { displayPreference: { preference: "off" } },
 *   applePay: { displayPreference: { preference: "off" } },
 *   googlePay: { displayPreference: { preference: "off" } },
 * });
 * ```
 *
 * ### Updating a Configuration
 * **Example:** Rename and enable US bank account
 * ```typescript
 * const checkout = yield* Stripe.PaymentMethodConfiguration("checkout", {
 *   name: "Checkout (updated)",
 *   card: { displayPreference: { preference: "on" } },
 *   usBankAccount: { displayPreference: { preference: "on" } },
 * });
 * ```
 *
 * ### Deactivating a Configuration
 * **Example:** Destroy deactivates rather than deleting
 * ```typescript
 * // stack.destroy() / resource removal sets active: false
 * const checkout = yield* Stripe.PaymentMethodConfiguration("checkout", {
 *   name: "Checkout",
 * });
 * ```
 *
 * @resource
 */
export const PaymentMethodConfiguration = Resource<PaymentMethodConfiguration>(
  "Stripe.PaymentMethodConfiguration",
);

export class PaymentMethodConfigurationNotResolved extends Data.TaggedError(
  "Stripe.PaymentMethodConfigurationNotResolved",
)<{
  name: string;
}> {}

type ConfigurationAttributes = PaymentMethodConfiguration["Attributes"];

type WireMethod = {
  display_preference: { preference: PaymentMethodPreference };
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH }))
    );
  });

const toMethodState = (
  value: PaymentMethodConfigResourcePaymentMethodProperties | undefined,
): PaymentMethodState | undefined => {
  if (value === undefined) return undefined;
  return {
    available: value.available,
    displayPreference: {
      overridable: value.display_preference.overridable ?? undefined,
      preference: value.display_preference.preference,
      value: value.display_preference.value,
    },
  };
};

const readMethod = (
  configuration: StripePaymentMethodConfiguration,
  snake: SnakeMethodKey,
): PaymentMethodState | undefined => toMethodState(configuration[snake]);

const toAttrs = (
  configuration: StripePaymentMethodConfiguration,
): ConfigurationAttributes => {
  const methods = {} as PaymentMethodAttributes;
  for (const [camel, snake] of METHOD_MAP) {
    methods[camel] = readMethod(configuration, snake);
  }
  return {
    id: configuration.id,
    name: configuration.name,
    active: configuration.active,
    isDefault: configuration.is_default,
    parent: configuration.parent ?? undefined,
    application: configuration.application ?? undefined,
    livemode: configuration.livemode,
    ...methods,
  };
};

const toWireMethods = (
  news: PaymentMethodConfigurationProps,
): Partial<Record<SnakeMethodKey, WireMethod>> => {
  const payload: Partial<Record<SnakeMethodKey, WireMethod>> = {};
  for (const [camel, snake] of METHOD_MAP) {
    const preference = news[camel]?.displayPreference?.preference;
    if (preference !== undefined) {
      payload[snake] = { display_preference: { preference } };
    }
  }
  return payload;
};

const toChangedWireMethods = (
  news: PaymentMethodConfigurationProps,
  current: StripePaymentMethodConfiguration,
): Partial<Record<SnakeMethodKey, WireMethod>> => {
  const payload: Partial<Record<SnakeMethodKey, WireMethod>> = {};
  for (const [camel, snake] of METHOD_MAP) {
    const desired = news[camel]?.displayPreference?.preference;
    if (desired === undefined) continue;
    const observed = readMethod(current, snake)?.displayPreference.preference;
    if (desired !== observed) {
      payload[snake] = { display_preference: { preference: desired } };
    }
  }
  return payload;
};

const isMissingConfiguration = isMissingStripeResource;

const getById = (configuration: string) =>
  GetPaymentMethodConfiguration({ configuration }).pipe(
    Effect.catchIf(isMissingConfiguration, () => Effect.succeed(undefined)),
  );

const listByActive = Effect.fn(function* (active: boolean) {
  const configurations: StripePaymentMethodConfiguration[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetPaymentMethodConfigurations({
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
  const configurations: StripePaymentMethodConfiguration[] = [];
  for (const configuration of [...active, ...inactive]) {
    if (seen.has(configuration.id)) continue;
    seen.add(configuration.id);
    configurations.push(configuration);
  }
  return configurations;
});

const findByName = Effect.fn(function* (name: string) {
  const configurations = yield* listAllConfigurations();
  const matches = configurations.filter(
    (configuration) => configuration.name === name && !configuration.is_default,
  );
  return matches.find((configuration) => configuration.active) ?? matches[0];
});

const observe = Effect.fn(function* (input: { id?: string; name?: string }) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  if (input.name !== undefined) {
    return yield* findByName(input.name);
  }
  return undefined;
});

const shouldReplace = (
  news: PaymentMethodConfigurationProps,
  output: ConfigurationAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.parent !== undefined && news.parent !== output.parent) {
    return true;
  }
  return false;
};

export const PaymentMethodConfigurationProvider = () =>
  Provider.succeed(PaymentMethodConfiguration, {
    stables: ["id", "parent", "application", "isDefault", "livemode"],

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
        name: output?.name,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      // No metadata. Identity is the Stripe id and unique name. Never
      // take over the account default configuration.
      return existing.is_default ? Unowned(attrs) : attrs;
    }),

    list: Effect.fn(function* () {
      // No metadata on this resource. Default list is active, non-default
      // configurations; deactivated rows stay in Stripe but must not
      // re-enter nuke. The account default is never returned.
      const configurations = yield* listByActive(true);
      return configurations
        .filter((configuration) => !configuration.is_default)
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const name = yield* toName(id, news.name, output?.name);
      const desiredActive = news.active ?? true;
      const wireMethods = toWireMethods(news);

      let current = yield* observe({
        id: output?.id,
        name,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }
      if (current?.is_default) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreatePaymentMethodConfiguration({
          name,
          ...(news.parent !== undefined ? { parent: news.parent } : {}),
          ...wireMethods,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-payment-method-configuration-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new PaymentMethodConfigurationNotResolved({ name });
      }

      const nameChanged = current.name !== name;
      const activeChanged = current.active !== desiredActive;
      const changedMethods = toChangedWireMethods(news, current);
      const methodsChanged = Object.keys(changedMethods).length > 0;

      if (!nameChanged && !activeChanged && !methodsChanged) {
        return toAttrs(current);
      }

      const updated = yield* UpdatePaymentMethodConfiguration({
        configuration: current.id,
        ...(nameChanged ? { name } : {}),
        ...(activeChanged ? { active: desiredActive } : {}),
        ...(methodsChanged ? changedMethods : {}),
      });
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || !existing.active || existing.is_default) {
        return;
      }
      yield* UpdatePaymentMethodConfiguration({
        configuration: existing.id,
        active: false,
      }).pipe(Effect.catchIf(isMissingConfiguration, () => Effect.void));
    }),
  });
