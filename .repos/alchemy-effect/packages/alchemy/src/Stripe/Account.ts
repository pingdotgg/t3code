import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteAccount,
  GetAccounts,
  GetAccountByAccount,
  CreateAccount,
  UpdateAccount,
  type Account as StripeAccount,
  type AccountBusinessType as StripeAccountBusinessType,
  type AccountType as StripeAccountType,
  type CreateAccountRequestBusinessProfile,
  type CreateAccountRequestCapabilities,
  type CreateAccountRequestCompany,
  type CreateAccountRequestController,
  type CreateAccountRequestIndividual,
  type CreateAccountRequestSettings,
  type CreateAccountRequestTosAcceptance,
} from "@distilled.cloud/stripe/stripe";
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

/** Connected-account kinds accepted by `POST /v1/accounts`. */
export type AccountKind = "custom" | "express" | "standard";

/** Legal structure of the account holder. */
export type AccountBusinessType = StripeAccountBusinessType;

/** Stripe-reported account type, including `none` for controller-created accounts. */
export type AccountType = StripeAccountType;

export interface AccountBusinessProfile {
  /**
   * Customer-facing business name.
   */
  name?: string;
  /**
   * Public website of the business.
   */
  url?: string;
  /**
   * Merchant category code (MCC).
   */
  mcc?: string;
  /**
   * Internal description of the product or service. Used by Stripe for
   * underwriting.
   */
  productDescription?: string;
  /**
   * Public support email.
   */
  supportEmail?: string;
  /**
   * Public support phone.
   */
  supportPhone?: string;
  /**
   * Public support URL.
   */
  supportUrl?: string;
}

export interface AccountControllerFees {
  /**
   * Who pays Stripe fees on this account.
   * @default "account"
   */
  payer?: "account" | "application";
}

export interface AccountControllerLosses {
  /**
   * Who is liable for negative balances.
   * @default "stripe"
   */
  payments?: "application" | "stripe";
}

export interface AccountControllerDashboard {
  /**
   * Stripe-hosted dashboard access: full Dashboard, Express, or none.
   * @default "full"
   */
  type?: "express" | "full" | "none";
}

export interface AccountController {
  /**
   * Who pays Stripe fees for product usage on this account.
   */
  fees?: AccountControllerFees;
  /**
   * Who is liable for negative balances on this account.
   */
  losses?: AccountControllerLosses;
  /**
   * Who collects updated information when requirements are due.
   * @default "stripe"
   */
  requirementCollection?: "application" | "stripe";
  /**
   * Stripe-hosted dashboard access.
   */
  stripeDashboard?: AccountControllerDashboard;
}

export interface AccountTosAcceptance {
  /**
   * Unix timestamp when the account representative accepted the service
   * agreement.
   */
  date?: number;
  /**
   * IP address from which the representative accepted the agreement.
   */
  ip?: string;
  /**
   * User agent of the browser that accepted the agreement.
   */
  userAgent?: string;
  /**
   * Service agreement type.
   */
  serviceAgreement?: string;
}

export interface AccountProps {
  /**
   * Kind of connected account to create — `standard`, `express`, or
   * `custom`. Create-only — changing it replaces the account.
   *
   * Mutually exclusive with {@link AccountProps.controller}. Omitting both
   * makes Stripe default to a Standard account.
   */
  type?: AccountKind;
  /**
   * Two-letter ISO country code of the account holder (e.g. `"US"`).
   * Create-only — changing it replaces the account. When omitted, Stripe
   * defaults to the platform's country.
   */
  country?: string;
  /**
   * Email address of the account holder. Used to identify the account;
   * Stripe does not market to it. Mutable.
   */
  email?: string;
  /**
   * Legal structure of the account holder. Mutable until Connect
   * onboarding starts on Standard and Express accounts.
   */
  businessType?: AccountBusinessType;
  /**
   * Public-facing business information (name, URL, support contacts, MCC).
   * Mutable.
   */
  businessProfile?: AccountBusinessProfile;
  /**
   * Capabilities to request, keyed by Stripe capability name
   * (`card_payments`, `transfers`, …) with `{ requested: boolean }`.
   * Mutable — requesting a capability does not activate it; Stripe
   * activates it once requirements are met.
   *
   * Nested fields use Stripe's wire names.
   */
  capabilities?: CreateAccountRequestCapabilities;
  /**
   * Account behaviour settings (branding, payouts, card payments, …).
   * Mutable. Nested fields use Stripe's wire names.
   */
  settings?: CreateAccountRequestSettings;
  /**
   * Three-letter ISO currency code used as the account's default currency.
   * Must be a currency Stripe supports in the account's country. Mutable.
   */
  defaultCurrency?: string;
  /**
   * Company or business details. Available for any `businessType`. Mutable
   * while `controller.requirement_collection` is `application` (Custom).
   * Nested fields use Stripe's wire names.
   */
  company?: CreateAccountRequestCompany;
  /**
   * Individual represented by the account. Only meaningful when
   * `businessType` is `individual`. Nested fields use Stripe's wire names.
   */
  individual?: CreateAccountRequestIndividual;
  /**
   * Record of the account holder accepting the Stripe Services Agreement.
   * Only settable for Custom accounts.
   */
  tosAcceptance?: AccountTosAcceptance;
  /**
   * Who is responsible for fees, losses, requirement collection, and
   * dashboard access. Create-only — changing it replaces the account.
   *
   * Mutually exclusive with {@link AccountProps.type}.
   */
  controller?: AccountController;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`.
   */
  metadata?: Record<string, string>;
}

export type Account = Resource<
  "Stripe.Account",
  AccountProps,
  {
    /** Stripe account id (`acct_…`). */
    id: string;
    /**
     * Stripe account type — `standard`, `express`, `custom`, or `none`
     * for accounts created with an explicit `controller`.
     */
    type: AccountType | undefined;
    /** Two-letter ISO country code the account is registered in. */
    country: string | undefined;
    /** Email address associated with the account. */
    email: string | undefined;
    /** Legal structure of the account holder, once known. */
    businessType: AccountBusinessType | undefined;
    /** Three-letter ISO code of the account's default currency. */
    defaultCurrency: string | undefined;
    /** Customer-facing business name, if set. */
    businessProfileName: string | undefined;
    /** Public website of the business, if set. */
    businessProfileUrl: string | undefined;
    /** Whether the account can currently process charges. */
    chargesEnabled: boolean;
    /** Whether funds in the account can currently be paid out. */
    payoutsEnabled: boolean;
    /**
     * Whether the account has finished submitting its details. Accounts
     * with Dashboard access cannot receive payouts until this is `true`.
     */
    detailsSubmitted: boolean;
    /**
     * Capability name → status (`active`, `pending`, `inactive`) for every
     * capability Stripe reports on the account.
     */
    capabilities: Record<string, string>;
    /**
     * Fields Stripe needs before the account's capabilities stay enabled.
     */
    requirementsCurrentlyDue: string[];
    /** Why the account is currently disabled, if it is. */
    requirementsDisabledReason: string | undefined;
    /** Unix timestamp when the account was connected. */
    created: number | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Stripe Connect connected account — a Standard, Express, or Custom
 * account created by your platform on behalf of a user.
 *
 * Creating an account is only the first step of onboarding: Stripe
 * activates requested capabilities once the account satisfies their
 * requirements, so a freshly created account normally reports
 * `chargesEnabled: false` and a non-empty `requirementsCurrentlyDue`.
 * Account Links are one-shot URLs and are not modeled as resources.
 *
 * `type`, `country`, and `controller` are fixed at creation. Email,
 * business profile, capabilities, settings, and metadata update in
 * place. Deleting the resource deletes the connected account.
 *
 * @see https://docs.stripe.com/api/accounts
 *
 * ### Creating an Account
 * **Example:** A Standard connected account
 * ```typescript
 * const account = yield* Stripe.Account("Merchant", {
 *   type: "standard",
 *   country: "US",
 *   email: "merchant@example.com",
 * });
 * ```
 *
 * **Example:** An Express account requesting payment capabilities
 * ```typescript
 * const account = yield* Stripe.Account("Merchant", {
 *   type: "express",
 *   country: "US",
 *   email: "merchant@example.com",
 *   capabilities: {
 *     card_payments: { requested: true },
 *     transfers: { requested: true },
 *   },
 * });
 * ```
 *
 * ### Fully configuring an Account
 * **Example:** Business profile, payouts, and metadata
 * ```typescript
 * const account = yield* Stripe.Account("Merchant", {
 *   type: "express",
 *   country: "US",
 *   email: "merchant@example.com",
 *   businessType: "company",
 *   defaultCurrency: "usd",
 *   businessProfile: {
 *     name: "Example Merchant",
 *     url: "https://example.com",
 *     mcc: "5734",
 *     supportEmail: "support@example.com",
 *   },
 *   capabilities: {
 *     card_payments: { requested: true },
 *     transfers: { requested: true },
 *   },
 *   settings: {
 *     payouts: { schedule: { interval: "manual" } },
 *   },
 *   metadata: { tier: "gold" },
 * });
 * ```
 *
 * ### Controller instead of type
 * **Example:** Custom responsibilities without `type`
 * ```typescript
 * const account = yield* Stripe.Account("Merchant", {
 *   country: "US",
 *   controller: {
 *     losses: { payments: "application" },
 *     fees: { payer: "application" },
 *     requirementCollection: "application",
 *     stripeDashboard: { type: "none" },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Account = Resource<Account>("Stripe.Account");

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const capabilityStatuses = (
  capabilities: StripeAccount["capabilities"],
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(capabilities ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

const toWireBusinessProfile = (
  profile: AccountBusinessProfile,
): CreateAccountRequestBusinessProfile => ({
  ...(profile.name !== undefined ? { name: profile.name } : {}),
  ...(profile.url !== undefined ? { url: profile.url } : {}),
  ...(profile.mcc !== undefined ? { mcc: profile.mcc } : {}),
  ...(profile.productDescription !== undefined
    ? { product_description: profile.productDescription }
    : {}),
  ...(profile.supportEmail !== undefined
    ? { support_email: profile.supportEmail }
    : {}),
  ...(profile.supportPhone !== undefined
    ? { support_phone: profile.supportPhone }
    : {}),
  ...(profile.supportUrl !== undefined
    ? { support_url: profile.supportUrl }
    : {}),
});

const toWireController = (
  controller: AccountController,
): CreateAccountRequestController => ({
  ...(controller.fees !== undefined
    ? {
        fees: {
          ...(controller.fees.payer !== undefined
            ? { payer: controller.fees.payer }
            : {}),
        },
      }
    : {}),
  ...(controller.losses !== undefined
    ? {
        losses: {
          ...(controller.losses.payments !== undefined
            ? { payments: controller.losses.payments }
            : {}),
        },
      }
    : {}),
  ...(controller.requirementCollection !== undefined
    ? { requirement_collection: controller.requirementCollection }
    : {}),
  ...(controller.stripeDashboard !== undefined
    ? {
        stripe_dashboard: {
          ...(controller.stripeDashboard.type !== undefined
            ? { type: controller.stripeDashboard.type }
            : {}),
        },
      }
    : {}),
});

const toWireTosAcceptance = (
  tos: AccountTosAcceptance,
): CreateAccountRequestTosAcceptance => ({
  ...(tos.date !== undefined ? { date: tos.date } : {}),
  ...(tos.ip !== undefined ? { ip: tos.ip } : {}),
  ...(tos.userAgent !== undefined ? { user_agent: tos.userAgent } : {}),
  ...(tos.serviceAgreement !== undefined
    ? { service_agreement: tos.serviceAgreement }
    : {}),
});

const toAttrs = (account: StripeAccount) => ({
  id: account.id,
  type: account.type,
  country: account.country,
  email: account.email ?? undefined,
  businessType: account.business_type ?? undefined,
  defaultCurrency: account.default_currency,
  businessProfileName: account.business_profile?.name ?? undefined,
  businessProfileUrl: account.business_profile?.url ?? undefined,
  chargesEnabled: account.charges_enabled ?? false,
  payoutsEnabled: account.payouts_enabled ?? false,
  detailsSubmitted: account.details_submitted ?? false,
  capabilities: capabilityStatuses(account.capabilities),
  requirementsCurrentlyDue: [...(account.requirements?.currently_due ?? [])],
  requirementsDisabledReason:
    account.requirements?.disabled_reason ?? undefined,
  created: account.created,
  metadata: userMetadata(account.metadata),
});

const isMissingAccount = isMissingStripeResource;

const getById = (account: string) =>
  GetAccountByAccount({ account }).pipe(
    Effect.catchIf(isMissingAccount, () => Effect.succeed(undefined)),
  );

const listAllAccounts = Effect.fn(function* () {
  const accounts: StripeAccount[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetAccounts({
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    accounts.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return accounts;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const accounts = yield* listAllAccounts();
  const matches: StripeAccount[] = [];
  for (const account of accounts) {
    if (yield* hasAlchemyMetadata(id, tagRecord(account.metadata))) {
      matches.push(account);
    }
  }
  matches.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
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

const businessProfileChanged = (
  desired: AccountBusinessProfile | undefined,
  observed: StripeAccount["business_profile"],
): boolean => {
  if (desired === undefined) return false;
  if (
    desired.name !== undefined &&
    desired.name !== (observed?.name ?? undefined)
  ) {
    return true;
  }
  if (
    desired.url !== undefined &&
    desired.url !== (observed?.url ?? undefined)
  ) {
    return true;
  }
  if (
    desired.mcc !== undefined &&
    desired.mcc !== (observed?.mcc ?? undefined)
  ) {
    return true;
  }
  if (
    desired.productDescription !== undefined &&
    desired.productDescription !== (observed?.product_description ?? undefined)
  ) {
    return true;
  }
  if (
    desired.supportEmail !== undefined &&
    desired.supportEmail !== (observed?.support_email ?? undefined)
  ) {
    return true;
  }
  if (
    desired.supportPhone !== undefined &&
    desired.supportPhone !== (observed?.support_phone ?? undefined)
  ) {
    return true;
  }
  if (
    desired.supportUrl !== undefined &&
    desired.supportUrl !== (observed?.support_url ?? undefined)
  ) {
    return true;
  }
  return false;
};

const capabilitiesDiverge = (
  desired: CreateAccountRequestCapabilities | undefined,
  observed: Record<string, string>,
): boolean => {
  if (desired === undefined) return false;
  return Object.entries(desired).some(([name, value]) => {
    const requested = value?.requested;
    if (requested === undefined) return false;
    const status = observed[name];
    const onFile = status === "active" || status === "pending";
    return requested !== onFile;
  });
};

const shouldReplace = (
  news: AccountProps,
  olds: AccountProps | undefined,
  output: Account["Attributes"] | undefined,
): boolean => {
  if (
    news.type !== undefined &&
    output?.type !== undefined &&
    news.type !== output.type
  ) {
    return true;
  }
  if (
    news.country !== undefined &&
    output?.country !== undefined &&
    news.country !== output.country
  ) {
    return true;
  }
  if (
    olds !== undefined &&
    news.controller !== undefined &&
    !deepEqual(news.controller, olds.controller, { stripNullish: true })
  ) {
    return true;
  }
  return false;
};

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: ["id", "type", "country", "created"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, olds, output)) {
        return { action: "replace" as const };
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
      const accounts = yield* listAllAccounts();
      return accounts
        .filter((account) => {
          const metadata = tagRecord(account.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const businessProfile =
        news.businessProfile !== undefined
          ? toWireBusinessProfile(news.businessProfile)
          : undefined;
      const controller =
        news.controller !== undefined
          ? toWireController(news.controller)
          : undefined;
      const tosAcceptance =
        news.tosAcceptance !== undefined
          ? toWireTosAcceptance(news.tosAcceptance)
          : undefined;

      let current = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      let createdThisPass = false;

      if (current === undefined) {
        current = yield* CreateAccount({
          ...(news.type !== undefined ? { type: news.type } : {}),
          ...(news.country !== undefined ? { country: news.country } : {}),
          ...(controller !== undefined ? { controller } : {}),
          ...(news.email !== undefined ? { email: news.email } : {}),
          ...(news.businessType !== undefined
            ? { business_type: news.businessType }
            : {}),
          ...(businessProfile !== undefined
            ? { business_profile: businessProfile }
            : {}),
          ...(news.capabilities !== undefined
            ? { capabilities: news.capabilities }
            : {}),
          ...(news.settings !== undefined ? { settings: news.settings } : {}),
          ...(news.defaultCurrency !== undefined
            ? { default_currency: news.defaultCurrency }
            : {}),
          ...(news.company !== undefined ? { company: news.company } : {}),
          ...(news.individual !== undefined
            ? { individual: news.individual }
            : {}),
          ...(tosAcceptance !== undefined
            ? { tos_acceptance: tosAcceptance }
            : {}),
          metadata,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-account-${instanceId}`,
          }),
        );
        createdThisPass = true;
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const emailChanged =
        news.email !== undefined && (current.email ?? undefined) !== news.email;
      const businessTypeChanged =
        news.businessType !== undefined &&
        (current.business_type ?? undefined) !== news.businessType;
      const defaultCurrencyChanged =
        news.defaultCurrency !== undefined &&
        current.default_currency !== news.defaultCurrency;
      const profileChanged = businessProfileChanged(
        news.businessProfile,
        current.business_profile,
      );
      const capsChanged = capabilitiesDiverge(
        news.capabilities,
        capabilityStatuses(current.capabilities),
      );
      const writeOnlyChanged =
        !createdThisPass &&
        ((news.settings !== undefined &&
          (olds === undefined ||
            !deepEqual(news.settings, olds.settings, {
              stripNullish: true,
            }))) ||
          (news.company !== undefined &&
            (olds === undefined ||
              !deepEqual(news.company, olds.company, {
                stripNullish: true,
              }))) ||
          (news.individual !== undefined &&
            (olds === undefined ||
              !deepEqual(news.individual, olds.individual, {
                stripNullish: true,
              }))) ||
          (news.tosAcceptance !== undefined &&
            (olds === undefined ||
              !deepEqual(news.tosAcceptance, olds.tosAcceptance, {
                stripNullish: true,
              }))));

      if (
        !emailChanged &&
        !businessTypeChanged &&
        !defaultCurrencyChanged &&
        !profileChanged &&
        !capsChanged &&
        !writeOnlyChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdateAccount({
        account: current.id,
        ...(emailChanged ? { email: news.email } : {}),
        ...(businessTypeChanged ? { business_type: news.businessType } : {}),
        ...(defaultCurrencyChanged
          ? { default_currency: news.defaultCurrency }
          : {}),
        ...(profileChanged ? { business_profile: businessProfile } : {}),
        ...(capsChanged ? { capabilities: news.capabilities } : {}),
        ...(writeOnlyChanged && news.settings !== undefined
          ? { settings: news.settings }
          : {}),
        ...(writeOnlyChanged && news.company !== undefined
          ? { company: news.company }
          : {}),
        ...(writeOnlyChanged && news.individual !== undefined
          ? { individual: news.individual }
          : {}),
        ...(writeOnlyChanged && tosAcceptance !== undefined
          ? { tos_acceptance: tosAcceptance }
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
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteAccount({ account: output.id }).pipe(
        Effect.catchIf(isMissingAccount, () => Effect.void),
      );
    }),
  });
