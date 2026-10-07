import * as datamanager from "@distilled.cloud/gcp/datamanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountOf,
  accountTypeOf,
  DEFAULT_ACCOUNT_TYPE,
  DEFAULT_MEMBERSHIP_STATUS,
  findUserListByDisplayName,
  getUserList,
  ignoreMissing,
  ingestedFromRow,
  ingestedIdentity,
  lastSegment,
  parentOf,
  replaceOnIdentity,
  resolveParent,
  resourceName,
  sameText,
  toDisplayName,
  toIngestedBody,
  updateMaskOf,
  type AccountAccessStatus,
  type AccountType,
  type IngestedUserListInfoProps,
  type MembershipStatus,
  type TargetNetworkInfoProps,
} from "./internal.ts";

export type AccountTypesUserListProps = {
  /**
   * Parent account. Full name
   * `accountTypes/{accountType}/accounts/{account}`. Immutable —
   * changing it replaces the user list. If omitted, constructed from
   * `accountType` and `account`.
   */
  parent?: string;
  /**
   * Product account type (`GOOGLE_ADS`, `DISPLAY_VIDEO_ADVERTISER`, …).
   * Used with `account` when `parent` is omitted. Immutable.
   * @default "GOOGLE_ADS"
   */
  accountType?: AccountType;
  /**
   * Destination account id (Google Ads customer id, DV360 advertiser
   * id, …). Used with `accountType` when `parent` is omitted. Immutable.
   */
  account?: string;
  /**
   * Server-assigned user list id (last path segment). Immutable —
   * changing it replaces the user list.
   */
  userListId?: string;
  /**
   * Human-readable display name. If omitted, a unique name is generated
   * from the stack, stage, and logical id.
   */
  displayName?: string;
  /**
   * User-facing description, sent as given.
   */
  description?: string;
  /**
   * Membership status (`OPEN` or `CLOSED`).
   * @default "OPEN"
   */
  membershipStatus?: MembershipStatus;
  /**
   * How long a user stays on the list. Must be an exact multiple of 24
   * hours (for example `"2592000s"`).
   */
  membershipDuration?: string;
  /**
   * External correlation id used by user-list sellers.
   */
  integrationCode?: string;
  /**
   * Whether a shared list is still enabled for this account
   * (`ENABLED` or `DISABLED`).
   */
  accountAccessStatus?: AccountAccessStatus;
  /**
   * Eligibility for Search and Display targeting.
   */
  targetNetworkInfo?: TargetNetworkInfoProps;
  /**
   * Ingested (Customer Match) list configuration. `uploadKeyTypes` is
   * immutable — changing it replaces the list.
   * @default { uploadKeyTypes: ["CONTACT_ID"] }
   */
  ingestedUserListInfo?: IngestedUserListInfoProps;
};

export type AccountTypesUserList = Resource<
  "GCP.DataManager.AccountTypesUserList",
  AccountTypesUserListProps,
  {
    /** Full resource name `accountTypes/{accountType}/accounts/{account}/userLists/{userList}`. */
    name: string;
    /** Server-assigned user list id (last path segment). */
    userListId: string;
    /** Parent account resource name. */
    parent: string;
    /** Product account type. */
    accountType: string;
    /** Destination account id. */
    account: string;
    /** Project id used when the user list was reconciled. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User-facing description. */
    description: string | undefined;
    /** Membership status. */
    membershipStatus: string | undefined;
    /** Membership duration. */
    membershipDuration: string | undefined;
    /** External correlation id. */
    integrationCode: string | undefined;
    /** Shared-list access status. */
    accountAccessStatus: string | undefined;
    /** Search/Display eligibility. */
    targetNetworkInfo: TargetNetworkInfoProps | undefined;
    /** Ingested list configuration (output-only match metrics omitted). */
    ingestedUserListInfo: IngestedUserListInfoProps | undefined;
    /** Why this account can access the list. */
    accessReason: string | undefined;
    /** Why membership is closed, if it is. */
    closingReason: string | undefined;
    /** Whether the list is read-only for this account. */
    readOnly: boolean | undefined;
    /** Estimated member counts by network. */
    sizeInfo: datamanager.SizeInfo | undefined;
  },
  never,
  Providers
>;

/**
 * A Data Manager API user list
 * (`accountTypes/{accountType}/accounts/{account}/userLists/{userList}`).
 *
 * User lists have no labels field and their text is shown in the ads
 * product, so Alchemy writes no ownership marker: it tracks the list by
 * name, or by the generated display name. Parent account and user list id are
 * identity — changing either replaces the list. `uploadKeyTypes` on
 * `ingestedUserListInfo` is immutable. Display name, description,
 * membership, and targeting update in place. Creating a list requires a
 * Google Ads, DV360, or data-partner account the credentials can write.
 *
 * ### Creating a User List
 * **Example:** Generated display name
 * ```typescript
 * const list = yield* GCP.DataManager.AccountTypesUserList("Customers", {
 *   parent: "accountTypes/GOOGLE_ADS/accounts/1234567890",
 * });
 * ```
 *
 * **Example:** Named Customer Match list
 * ```typescript
 * const list = yield* GCP.DataManager.AccountTypesUserList("Customers", {
 *   parent: "accountTypes/GOOGLE_ADS/accounts/1234567890",
 *   displayName: "checkout-buyers",
 *   membershipDuration: "2592000s",
 *   ingestedUserListInfo: { uploadKeyTypes: ["CONTACT_ID"] },
 * });
 * ```
 *
 * ### Updating a User List
 * **Example:** Rename and close membership
 * ```typescript
 * // Same logical id, changed props: the list is patched in place.
 * const list = yield* GCP.DataManager.AccountTypesUserList("Customers", {
 *   parent: "accountTypes/GOOGLE_ADS/accounts/1234567890",
 *   displayName: "checkout-buyers-v2",
 *   membershipStatus: "CLOSED",
 * });
 * ```
 *
 * @resource
 * @category DataManager
 */
export const AccountTypesUserList = Resource<AccountTypesUserList>(
  "GCP.DataManager.AccountTypesUserList",
);

export class AccountTypesUserListNotResolved extends Data.TaggedError(
  "GCP.DataManager.AccountTypesUserListNotResolved",
)<{
  parent: string;
  name: string;
}> {}

export class AccountTypesUserListParentRequired extends Data.TaggedError(
  "GCP.DataManager.AccountTypesUserListParentRequired",
)<{
  message: string;
}> {}

const lookupName = (
  parent: string,
  userListId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName && existingName.length > 0) return existingName;
  if (userListId && userListId.length > 0 && parent.length > 0) {
    return resourceName(parent, userListId);
  }
  return "";
};

const targetNetworkOf = (
  info: datamanager.TargetNetworkInfo | undefined,
): TargetNetworkInfoProps | undefined => {
  if (info === undefined) return undefined;
  return {
    eligibleForDisplay: info.eligibleForDisplay,
    eligibleForSearch: info.eligibleForSearch,
  };
};

const toAttrs = (row: datamanager.UserList, project: string) => {
  const name = row.name ?? "";
  const parent = parentOf(name);
  return {
    name,
    userListId: row.id ?? lastSegment(name),
    parent,
    accountType: accountTypeOf(parent) || DEFAULT_ACCOUNT_TYPE,
    account: accountOf(parent),
    project,
    displayName: row.displayName,
    description: row.description,
    membershipStatus: row.membershipStatus,
    membershipDuration: row.membershipDuration,
    integrationCode: row.integrationCode,
    accountAccessStatus: row.accountAccessStatus,
    targetNetworkInfo: targetNetworkOf(row.targetNetworkInfo),
    ingestedUserListInfo: ingestedFromRow(row.ingestedUserListInfo),
    accessReason: row.accessReason,
    closingReason: row.closingReason,
    readOnly: row.readOnly,
    sizeInfo: row.sizeInfo,
  };
};

export const AccountTypesUserListProvider = () =>
  Provider.succeed(AccountTypesUserList, {
    stables: [
      "name",
      "userListId",
      "parent",
      "accountType",
      "account",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const nextParent = resolveParent({
        parent: news.parent,
        accountType: news.accountType,
        account: news.account,
      });
      return replaceOnIdentity({
        previousParent: olds?.parent ?? output?.parent,
        nextParent,
        previousId: olds?.userListId ?? output?.userListId,
        nextId: news.userListId,
        previousIngested: ingestedIdentity(
          olds?.ingestedUserListInfo ?? output?.ingestedUserListInfo,
        ),
        nextIngested: ingestedIdentity(news.ingestedUserListInfo),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = resolveParent({
        parent: olds?.parent ?? output?.parent,
        accountType: olds?.accountType ?? output?.accountType,
        account: olds?.account ?? output?.account,
      });
      const name = lookupName(
        parent,
        olds?.userListId ?? output?.userListId,
        output?.name,
      );
      const byName = yield* getUserList(name);
      if (byName !== undefined) return toAttrs(byName, env.project);
      if (parent.length === 0) return undefined;
      const displayName = yield* toDisplayName(
        id,
        olds?.displayName,
        output?.displayName,
      );
      const existing = yield* findUserListByDisplayName(displayName, parent);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // A generated display name embeds the stack, stage, and logical id; a
      // chosen one may belong to someone else.
      return olds?.displayName === undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = resolveParent({
        parent: news.parent,
        accountType: news.accountType,
        account: news.account,
      });
      if (parent.length === 0) {
        return yield* new AccountTypesUserListParentRequired({
          message:
            "AccountTypesUserList requires parent or account (accountTypes/{accountType}/accounts/{account})",
        });
      }
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const description = news.description;
      const name = lookupName(
        parent,
        news.userListId ?? output?.userListId,
        output?.name,
      );

      let current = yield* getUserList(name);
      if (current === undefined) {
        current = yield* findUserListByDisplayName(displayName, parent);
      }

      const ingested = toIngestedBody(
        news.ingestedUserListInfo ??
          ingestedFromRow(current?.ingestedUserListInfo),
      );
      const membershipStatus =
        news.membershipStatus ??
        current?.membershipStatus ??
        DEFAULT_MEMBERSHIP_STATUS;
      const membershipDuration =
        news.membershipDuration ?? current?.membershipDuration;
      const integrationCode = news.integrationCode ?? current?.integrationCode;
      const accountAccessStatus =
        news.accountAccessStatus ?? current?.accountAccessStatus;
      const targetNetworkInfo =
        news.targetNetworkInfo ?? targetNetworkOf(current?.targetNetworkInfo);

      if (current === undefined) {
        current = yield* datamanager
          .createAccountTypesAccountsUserLists({
            parent,
            body: {
              displayName,
              description,
              membershipStatus,
              membershipDuration,
              integrationCode,
              accountAccessStatus,
              targetNetworkInfo,
              ingestedUserListInfo: ingested,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findUserListByDisplayName(displayName, parent).pipe(
                Effect.flatMap((row) =>
                  row
                    ? Effect.succeed(row)
                    : new AccountTypesUserListNotResolved({
                        parent,
                        name: displayName,
                      }),
                ),
              ),
            ),
          );
      }

      if (current === undefined) {
        return yield* new AccountTypesUserListNotResolved({
          parent,
          name: name || displayName,
        });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const membershipChanged = !sameText(
        current.membershipStatus,
        membershipStatus,
      );
      const durationChanged = !sameText(
        current.membershipDuration,
        membershipDuration,
      );
      const integrationChanged = !sameText(
        current.integrationCode,
        integrationCode,
      );
      const accessChanged = !sameText(
        current.accountAccessStatus,
        accountAccessStatus,
      );
      const networkChanged =
        JSON.stringify(targetNetworkOf(current.targetNetworkInfo) ?? null) !==
        JSON.stringify(targetNetworkInfo ?? null);
      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        descriptionChanged ? "description" : undefined,
        membershipChanged ? "membershipStatus" : undefined,
        durationChanged ? "membershipDuration" : undefined,
        integrationChanged ? "integrationCode" : undefined,
        accessChanged ? "accountAccessStatus" : undefined,
        networkChanged ? "targetNetworkInfo" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* datamanager.patchAccountTypesAccountsUserLists({
          name: currentName,
          updateMask,
          body: {
            displayName,
            description,
            membershipStatus,
            membershipDuration,
            integrationCode,
            accountAccessStatus,
            targetNetworkInfo,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreMissing(
        datamanager.deleteAccountTypesAccountsUserLists({ name: output.name }),
      );
    }),
  });
