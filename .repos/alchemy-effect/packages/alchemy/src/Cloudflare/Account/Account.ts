import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Account.Account" as const;
type TypeId = typeof TypeId;

/**
 * The kind of Cloudflare account. Cannot be changed after creation.
 */
export type AccountType = "standard" | "enterprise";

export interface AccountProps {
  /**
   * Account name (display name). Mutable in place. If omitted, a unique
   * name is generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The kind of account to create. Cannot be changed after creation —
   * Cloudflare rejects type changes (`UpdateAccountTypeNotSupported`), so
   * updating this property triggers a replacement.
   * @default "standard"
   */
  type?: AccountType;
  /**
   * Tenant unit to create the account under. Only meaningful for tenant /
   * partner credentials; defaults to the tenant's root unit. Create-only —
   * updating this property triggers a replacement.
   *
   * @see https://developers.cloudflare.com/tenant/how-to/manage-accounts/
   */
  unit?: {
    /**
     * The id of the tenant unit to create the account on.
     */
    id?: string;
  };
  /**
   * Abuse contact email address for the account
   * (`settings.abuse_contact_email`). Mutable in place. When omitted, the
   * setting is left unmanaged (an existing value is not cleared).
   */
  abuseContactEmail?: string;
  /**
   * Whether membership in this account requires that two-factor
   * authentication is enabled (`settings.enforce_twofactor`). Mutable in
   * place. When omitted, the setting is left unmanaged.
   * @default false
   */
  enforceTwofactor?: boolean;
}

export interface AccountAttributes {
  /**
   * Account identifier tag assigned by Cloudflare.
   */
  accountId: string;
  /**
   * Account name (display name).
   */
  name: string;
  /**
   * The kind of account.
   */
  type: AccountType;
  /**
   * Timestamp for the creation of the account.
   */
  createdOn: string | undefined;
  /**
   * Id of the tenant organization the account is managed by, if any.
   */
  parentOrgId: string | undefined;
  /**
   * Name of the tenant organization the account is managed by, if any.
   */
  parentOrgName: string | undefined;
  /**
   * Abuse contact email address configured on the account, if any.
   */
  abuseContactEmail: string | undefined;
  /**
   * Whether membership in the account requires two-factor authentication.
   */
  enforceTwofactor: boolean;
}

export type Account = Resource<
  TypeId,
  AccountProps,
  AccountAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare account (subaccount), for tenant / partner platforms that
 * provision an account per customer.
 *
 * Creating accounts (`POST /accounts`) is restricted to credentials with the
 * tenant entitlement — a standard user receives the typed
 * `AccountCreationForbidden` error (Cloudflare error code 1002). The `name`
 * and account settings are mutable in place; `type` and the tenant `unit`
 * are create-only and trigger a replacement. Deleting the resource queues
 * the account for deletion (also tenant-gated).
 *
 * The account's physical identity is the Cloudflare-assigned `accountId`.
 * Account names are not unique, so there is no find-by-name fallback: if
 * state is lost, the account is treated as missing rather than guessed at.
 * @resource
 * @product Accounts
 * @category Account & Identity
 * @section Creating an account
 * @example Standard subaccount with a generated name
 * ```typescript
 * const account = yield* Cloudflare.Account.Account("CustomerAccount", {});
 * ```
 *
 * @example Subaccount on a specific tenant unit
 * ```typescript
 * const account = yield* Cloudflare.Account.Account("CustomerAccount", {
 *   name: "Customer: ACME Inc",
 *   unit: { id: tenantUnitId },
 * });
 * ```
 *
 * @section Account settings
 * @example Enforce two-factor authentication for all members
 * ```typescript
 * const account = yield* Cloudflare.Account.Account("CustomerAccount", {
 *   name: "Customer: ACME Inc",
 *   enforceTwofactor: true,
 *   abuseContactEmail: "abuse@acme.example",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/tenant/how-to/manage-accounts/
 */
export const Account = Resource<Account>(TypeId, {
  aliases: ["Cloudflare.Account"],
});

/**
 * Returns true if the given value is an Account resource.
 */
export const isAccount = (value: unknown): value is Account =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: ["accountId", "type", "createdOn", "parentOrgId", "parentOrgName"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // The account type cannot be changed after creation — Cloudflare
      // rejects it with `UpdateAccountTypeNotSupported`.
      const oldType = output?.type ?? olds?.type ?? "standard";
      if ((news.type ?? "standard") !== oldType) {
        return { action: "replace" } as const;
      }
      // The tenant unit is a create-only placement decision.
      if ((olds?.unit?.id ?? undefined) !== (news.unit?.id ?? undefined)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    list: () =>
      // `listAccounts` (GET /accounts) enumerates every account the API
      // token can access — no scope input required. The list items carry
      // the full account shape (settings + managedBy), so each maps
      // directly to the same `Attributes` `read` produces with no
      // per-item hydration. Paginate exhaustively.
      accounts.listAccounts.pages({}).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((account) => toAttributes(account)),
          ),
        ),
      ),

    read: Effect.fn(function* ({ output }) {
      // The physical identity is the Cloudflare-assigned account id —
      // names are not unique, so there is no cold find-by-name fallback.
      if (!output?.accountId) return undefined;
      const observed = yield* getAccount(output.accountId);
      return observed ? toAttributes(observed) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name =
        news.name ?? (yield* createPhysicalName({ id, lowercase: true }));

      // 1. Observe — the account id cached on `output` is a hint, not a
      //    guarantee: a deleted account falls through to create.
      let observed = output?.accountId
        ? yield* getAccount(output.accountId)
        : undefined;

      // 2. Ensure — create when missing. Names are not unique on
      //    Cloudflare's side, so there is no AlreadyExists race to
      //    tolerate. Requires the tenant entitlement: a standard user
      //    surfaces the typed `AccountCreationForbidden` (code 1002).
      if (!observed) {
        observed = yield* accounts.createAccount({
          name,
          type: news.type,
          unit: news.unit,
        });
      }

      // 3. Sync — diff observed cloud state against desired; skip the PUT
      //    entirely on a no-op. Settings props left undefined are
      //    unmanaged: the observed value is kept as-is.
      const settings = observed.settings ?? undefined;
      const nameDirty = observed.name !== name;
      const abuseDirty =
        news.abuseContactEmail !== undefined &&
        (settings?.abuseContactEmail ?? undefined) !== news.abuseContactEmail;
      const twofactorDirty =
        news.enforceTwofactor !== undefined &&
        (settings?.enforceTwofactor ?? false) !== news.enforceTwofactor;

      if (nameDirty || abuseDirty || twofactorDirty) {
        observed = yield* accounts.updateAccount({
          accountId: observed.id,
          id: observed.id,
          name,
          settings:
            abuseDirty || twofactorDirty
              ? {
                  abuseContactEmail: news.abuseContactEmail,
                  enforceTwofactor: news.enforceTwofactor,
                }
              : undefined,
        });
      }

      return toAttributes(observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Account deletion is queued / asynchronous on Cloudflare's side —
      // a successful DELETE means "pending deletion", which is success for
      // us. An already-gone (or already-pending) account surfaces as
      // `InvalidRoute` (code 7003): that's success too.
      yield* accounts
        .deleteAccount({ accountId: output.accountId })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.void));
    }),
  });

type ObservedAccount =
  | accounts.GetAccountResponse
  | accounts.CreateAccountResponse
  | accounts.UpdateAccountResponse
  | accounts.ListAccountsResponse["result"][number];

/**
 * Read an account by id, mapping "gone" to `undefined`. A missing (or
 * deletion-pending) account surfaces as `InvalidRoute` (Cloudflare error
 * code 7003).
 */
const getAccount = (accountId: string) =>
  accounts.getAccount({ accountId }).pipe(
    Effect.map((account): ObservedAccount | undefined => account),
    Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
  );

const toAttributes = (account: ObservedAccount): AccountAttributes => ({
  accountId: account.id,
  name: account.name,
  // Distilled widens generated string enums to open unions (`string & {}`).
  type: account.type as AccountType,
  createdOn: account.createdOn ?? undefined,
  parentOrgId: account.managedBy?.parentOrgId ?? undefined,
  parentOrgName: account.managedBy?.parentOrgName ?? undefined,
  abuseContactEmail: account.settings?.abuseContactEmail ?? undefined,
  enforceTwofactor: account.settings?.enforceTwofactor ?? false,
});
