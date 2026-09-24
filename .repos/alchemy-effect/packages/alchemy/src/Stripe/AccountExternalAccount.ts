import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteAccountExternalAccount,
  GetAccounts,
  GetAccountExternalAccounts,
  GetAccountExternalAccount,
  CreateAccountExternalAccount,
  UpdateAccountExternalAccount,
  type Account as StripeAccount,
  type BankAccount as StripeBankAccount,
  type Card as StripeCard,
  type ExternalAccount as StripeExternalAccount,
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
const LIST_CONCURRENCY = 10;

/** Entity that holds a bank external account. */
export type AccountExternalAccountHolderType = "individual" | "company";

/** Bank account type. `futsu` / `toza` are Japan-only. */
export type AccountExternalAccountBankType =
  | "checking"
  | "savings"
  | "futsu"
  | "toza";

/** Discriminator for a bank vs card external account. */
export type AccountExternalAccountObject = "bank_account" | "card";

export interface AccountExternalAccountProps {
  /**
   * Id of the Connect account this external account is attached to
   * (`acct_…`). Changing it replaces the external account.
   */
  account: string;
  /**
   * Single-use Stripe token (`btok_…` or `tok_…`) representing a bank
   * account or debit card. Used on create; changing it replaces the
   * external account. Tokens cannot be reused.
   */
  externalAccount: string;
  /**
   * When true, this becomes the default payout destination for its
   * currency. The first external account in a currency is default
   * automatically.
   */
  defaultForCurrency?: boolean;
  /**
   * Name of the person or business that owns the bank account (bank
   * accounts only).
   */
  accountHolderName?: string;
  /**
   * Type of entity that holds the bank account (`individual` or
   * `company`). Bank accounts only.
   */
  accountHolderType?: AccountExternalAccountHolderType;
  /**
   * Bank account type (`checking`, `savings`, `futsu`, or `toza`). Bank
   * accounts only.
   */
  accountType?: AccountExternalAccountBankType;
  /**
   * Cardholder name (cards only).
   */
  name?: string;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`.
   */
  metadata?: Record<string, string>;
}

export type AccountExternalAccount = Resource<
  "Stripe.AccountExternalAccount",
  AccountExternalAccountProps,
  {
    /** Stripe external account id (`ba_…` or `card_…`). */
    id: string;
    /** Id of the Connect account (`acct_…`). */
    account: string;
    /** Whether this is a bank account or a card. */
    object: AccountExternalAccountObject;
    /** Last four digits of the account or card number. */
    last4: string;
    /** Two-letter ISO country code of the bank or card. */
    country: string;
    /** Three-letter ISO currency code, if set. */
    currency: string | undefined;
    /** Bank name associated with the routing number (bank accounts only). */
    bankName: string | undefined;
    /** Routing transit number (bank accounts only). */
    routingNumber: string | undefined;
    /** Name of the person or business that owns the bank account. */
    accountHolderName: string | undefined;
    /** Type of entity that holds the bank account. */
    accountHolderType: string | undefined;
    /** Bank account type (`checking`, `savings`, …). */
    accountType: string | undefined;
    /** Whether this is the default external account for its currency. */
    defaultForCurrency: boolean;
    /** Status (`new`, `validated`, `errored`, …). */
    status: string | undefined;
    /** Card brand (cards only). */
    brand: string | undefined;
    /** Card funding type (`debit`, `credit`, …) (cards only). */
    funding: string | undefined;
    /** Cardholder name (cards only). */
    name: string | undefined;
    /** Fingerprint uniquely identifying the underlying number. */
    fingerprint: string | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Stripe Account External Account — a bank account or debit card
 * attached to a Connect account as a payout destination. Metadata,
 * account-holder details, and `defaultForCurrency` update in place.
 * Changing `account` or the `externalAccount` token replaces it.
 * Destroy deletes it.
 *
 * @see https://docs.stripe.com/api/external_accounts
 *
 * ### Creating an External Account
 * **Example:** Bank account token on a Connect account
 * ```typescript
 * const payout = yield* Stripe.AccountExternalAccount("payout-bank", {
 *   account: connected.id,
 *   externalAccount: bankToken.id,
 *   accountHolderName: "Jenny Rosen",
 *   accountHolderType: "individual",
 *   metadata: { purpose: "payouts" },
 * });
 * ```
 *
 * **Example:** Debit card token
 * ```typescript
 * const payout = yield* Stripe.AccountExternalAccount("payout-card", {
 *   account: connected.id,
 *   externalAccount: debitToken.id,
 *   defaultForCurrency: true,
 * });
 * ```
 *
 * ### Updating an External Account
 * **Example:** Holder name, default, and metadata
 * ```typescript
 * const payout = yield* Stripe.AccountExternalAccount("payout-bank", {
 *   account: connected.id,
 *   externalAccount: bankToken.id,
 *   accountHolderName: "Alchemy Tester",
 *   accountHolderType: "company",
 *   defaultForCurrency: true,
 *   metadata: { purpose: "payroll" },
 * });
 * ```
 *
 * @resource
 */
export const AccountExternalAccount = Resource<AccountExternalAccount>(
  "Stripe.AccountExternalAccount",
);

type AccountExternalAccountAttributes = AccountExternalAccount["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const isBankAccount = (
  value: StripeExternalAccount,
): value is StripeBankAccount => value.object === "bank_account";

const parentAccountId = (
  ea: StripeExternalAccount,
  fallback: string,
): string => {
  const raw = ea.account;
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (raw !== null && raw !== undefined && typeof raw === "object") {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return fallback;
};

const toAttrs = (
  fallbackAccount: string,
  ea: StripeExternalAccount,
): AccountExternalAccountAttributes => {
  const account = parentAccountId(ea, fallbackAccount);
  const metadata = userMetadata(ea.metadata);
  if (!isBankAccount(ea)) {
    const card: StripeCard = ea;
    return {
      id: card.id,
      account,
      object: "card",
      last4: card.last4,
      country: card.country ?? "",
      currency: card.currency ?? undefined,
      bankName: undefined,
      routingNumber: undefined,
      accountHolderName: undefined,
      accountHolderType: undefined,
      accountType: undefined,
      defaultForCurrency: card.default_for_currency ?? false,
      status: card.status ?? undefined,
      brand: card.brand,
      funding: card.funding,
      name: card.name ?? undefined,
      fingerprint: card.fingerprint ?? undefined,
      metadata,
    };
  }
  return {
    id: ea.id,
    account,
    object: "bank_account",
    last4: ea.last4,
    country: ea.country,
    currency: ea.currency,
    bankName: ea.bank_name ?? undefined,
    routingNumber: ea.routing_number ?? undefined,
    accountHolderName: ea.account_holder_name ?? undefined,
    accountHolderType: ea.account_holder_type ?? undefined,
    accountType: ea.account_type ?? undefined,
    defaultForCurrency: ea.default_for_currency ?? false,
    status: ea.status,
    brand: undefined,
    funding: undefined,
    name: undefined,
    fingerprint: ea.fingerprint ?? undefined,
    metadata,
  };
};

const isMissing = isMissingStripeResource;

const getById = (account: string, id: string) =>
  GetAccountExternalAccount({ account, id }).pipe(
    Effect.catchIf(isMissing, () => Effect.succeed(undefined)),
  );

const listExternalAccounts = Effect.fn(function* (account: string) {
  const accounts: StripeExternalAccount[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetAccountExternalAccounts({
      account,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    }).pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)));
    if (response === undefined) {
      break;
    }
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

const listAllConnectAccounts = Effect.fn(function* () {
  const accounts: StripeAccount[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetAccounts({
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    }).pipe(
      Effect.catchIf(
        (e) =>
          e._tag === "InvalidRequestError" ||
          e._tag === "Forbidden" ||
          e._tag === "Unauthorized",
        () => Effect.succeed(undefined),
      ),
    );
    if (response === undefined) {
      break;
    }
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

const findByAlchemyId = Effect.fn(function* (
  logicalId: string,
  account?: string,
) {
  const search = Effect.fn(function* (accountId: string) {
    const eas = yield* listExternalAccounts(accountId);
    const matches: StripeExternalAccount[] = [];
    for (const ea of eas) {
      if (yield* hasAlchemyMetadata(logicalId, tagRecord(ea.metadata))) {
        matches.push(ea);
      }
    }
    return matches[0];
  });
  if (account !== undefined) {
    return yield* search(account);
  }
  const accounts = yield* listAllConnectAccounts();
  for (const acct of accounts) {
    const found = yield* search(acct.id);
    if (found !== undefined) return found;
  }
  return undefined;
});

const observe = Effect.fn(function* (input: {
  account?: string;
  id?: string;
  logicalId: string;
}) {
  if (input.account !== undefined && input.id !== undefined) {
    const byId = yield* getById(input.account, input.id);
    if (byId !== undefined) return byId;
  }
  return yield* findByAlchemyId(input.logicalId, input.account);
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
  news: AccountExternalAccountProps,
  olds: AccountExternalAccountProps | undefined,
  output: AccountExternalAccountAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.account !== output.account) return true;
  if (
    olds !== undefined &&
    olds.externalAccount !== undefined &&
    news.externalAccount !== olds.externalAccount
  ) {
    return true;
  }
  return false;
};

export const AccountExternalAccountProvider = () =>
  Provider.succeed(AccountExternalAccount, {
    stables: [
      "id",
      "account",
      "object",
      "last4",
      "country",
      "currency",
      "bankName",
      "routingNumber",
      "fingerprint",
      "brand",
      "funding",
    ],
    nuke: { dependsOn: ["Stripe.Account"] },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, olds, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const account =
        output?.account ??
        (typeof olds?.account === "string" ? olds.account : undefined);
      const existing = yield* observe({
        account,
        id: output?.id,
        logicalId: id,
      });
      if (existing === undefined || account === undefined) return undefined;
      const attrs = toAttrs(account, existing);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const accounts = yield* listAllConnectAccounts();
      const rows = yield* Effect.forEach(
        accounts,
        (account) =>
          listExternalAccounts(account.id).pipe(
            Effect.map((eas) =>
              eas
                .filter(
                  (ea) =>
                    tagRecord(ea.metadata)[alchemyMetadataKeys.stack] !==
                    undefined,
                )
                .map((ea) => toAttrs(account.id, ea)),
            ),
          ),
        { concurrency: LIST_CONCURRENCY },
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredHolderName = news.accountHolderName ?? "";
      const desiredHolderType = news.accountHolderType ?? "";
      const desiredAccountType = news.accountType;
      const desiredName = news.name ?? "";
      const desiredDefault = news.defaultForCurrency;

      let current = yield* observe({
        account: news.account,
        id: output?.id,
        logicalId: id,
      });
      if (
        current !== undefined &&
        shouldReplace(news, olds, toAttrs(news.account, current))
      ) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateAccountExternalAccount({
          account: news.account,
          external_account: news.externalAccount,
          metadata,
          ...(desiredDefault !== undefined
            ? { default_for_currency: desiredDefault }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-account-external-account-${instanceId}`,
          }),
          Effect.catchIf(
            (e) => e._tag === "InvalidRequestError" || e._tag === "Conflict",
            (e) =>
              observe({
                account: news.account,
                logicalId: id,
              }).pipe(
                Effect.flatMap((found) =>
                  found !== undefined ? Effect.succeed(found) : Effect.fail(e),
                ),
              ),
          ),
        );
      }

      const attrs = toAttrs(news.account, current);
      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const defaultChanged =
        desiredDefault !== undefined &&
        attrs.defaultForCurrency !== desiredDefault;
      const holderNameChanged =
        attrs.object === "bank_account" &&
        (attrs.accountHolderName ?? "") !== desiredHolderName;
      const holderTypeChanged =
        attrs.object === "bank_account" &&
        (attrs.accountHolderType ?? "") !== desiredHolderType;
      const accountTypeChanged =
        attrs.object === "bank_account" &&
        desiredAccountType !== undefined &&
        (attrs.accountType ?? "") !== desiredAccountType;
      const nameChanged =
        attrs.object === "card" && (attrs.name ?? "") !== desiredName;

      if (
        !metadataChanged &&
        !defaultChanged &&
        !holderNameChanged &&
        !holderTypeChanged &&
        !accountTypeChanged &&
        !nameChanged
      ) {
        return attrs;
      }

      const updated = yield* UpdateAccountExternalAccount({
        account: news.account,
        id: current.id,
        ...(holderNameChanged
          ? { account_holder_name: desiredHolderName }
          : {}),
        ...(holderTypeChanged
          ? {
              account_holder_type:
                desiredHolderType === ""
                  ? ""
                  : (desiredHolderType as AccountExternalAccountHolderType),
            }
          : {}),
        ...(accountTypeChanged && desiredAccountType !== undefined
          ? { account_type: desiredAccountType }
          : {}),
        ...(nameChanged ? { name: desiredName } : {}),
        ...(defaultChanged && desiredDefault !== undefined
          ? { default_for_currency: desiredDefault }
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
      return toAttrs(news.account, updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteAccountExternalAccount({
        account: output.account,
        id: output.id,
      }).pipe(Effect.catchIf(isMissing, () => Effect.void));
    }),
  });
