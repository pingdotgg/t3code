import * as datamanager from "@distilled.cloud/gcp/datamanager_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";

export const DEFAULT_ACCOUNT_TYPE = "GOOGLE_ADS";
export const DEFAULT_MEMBERSHIP_STATUS = "OPEN";
export const DEFAULT_UPLOAD_KEY_TYPES: datamanager.IngestedUserListInfoUploadKeyTypesItemEnumList =
  ["CONTACT_ID"];
export const PROBE_PARENT = "accountTypes/GOOGLE_ADS/accounts/0";
export const PROBE_NAME = `${PROBE_PARENT}/userLists/0`;

export type AccountType =
  | datamanager.ProductAccountAccountTypeEnum
  | (string & {});

export type MembershipStatus =
  | datamanager.UserListMembershipStatusEnum
  | (string & {});

export type AccountAccessStatus =
  | datamanager.UserListAccountAccessStatusEnum
  | (string & {});

export type UploadKeyType =
  | datamanager.IngestedUserListInfoUploadKeyTypesItemEnum
  | (string & {});

export type TargetNetworkInfoProps = {
  /** Whether the list is eligible for the Google Display Network. */
  eligibleForDisplay?: boolean;
  /** Whether the list is eligible for Google Search. */
  eligibleForSearch?: boolean;
};

export type PartnerAudienceInfoProps = {
  /** Immutable source of the partner audience. */
  partnerAudienceSource?:
    | datamanager.PartnerAudienceInfoPartnerAudienceSourceEnum
    | (string & {});
  /** Commerce partner name. Only for `COMMERCE_AUDIENCE`. */
  commercePartner?: string;
};

export type MobileIdInfoProps = {
  /** Immutable mobile ID key space (`IOS` or `ANDROID`). */
  keySpace?: datamanager.MobileIdInfoKeySpaceEnum | (string & {});
  /** Immutable app id the mobile IDs were collected from. */
  appId?: string;
  /** Immutable source of the upload data. */
  dataSourceType?: datamanager.MobileIdInfoDataSourceTypeEnum | (string & {});
};

export type PairIdInfoProps = {
  /** Immutable publisher id in the clean room. */
  publisherId?: string;
  /** Membership match percentage (0-100). */
  matchRatePercentage?: number;
  /** Publisher display name. */
  publisherName?: string;
  /** Count of advertiser first-party records uploaded. */
  advertiserIdentifierCount?: string;
  /** Immutable advertiser-to-publisher clean room identifier. */
  cleanRoomIdentifier?: string;
};

export type ContactIdInfoProps = {
  /** Immutable source of the upload data. */
  dataSourceType?: datamanager.ContactIdInfoDataSourceTypeEnum | (string & {});
};

export type UserIdInfoProps = {
  /** Immutable source of the upload data. */
  dataSourceType?: datamanager.UserIdInfoDataSourceTypeEnum | (string & {});
};

export type IngestedUserListInfoProps = {
  /**
   * Immutable upload key types (`CONTACT_ID`, `MOBILE_ID`, `USER_ID`,
   * `PAIR_ID`, `PSEUDONYMOUS_ID`).
   * @default ["CONTACT_ID"]
   */
  uploadKeyTypes?: UploadKeyType[];
  /** Partner-audience metadata. Data partners only. */
  partnerAudienceInfo?: PartnerAudienceInfoProps;
  /** Extra fields when `MOBILE_ID` is an upload key type. */
  mobileIdInfo?: MobileIdInfoProps;
  /** Extra fields when `PAIR_ID` is an upload key type. Data partners only. */
  pairIdInfo?: PairIdInfoProps;
  /** Extra fields when `CONTACT_ID` is an upload key type. */
  contactIdInfo?: ContactIdInfoProps;
  /** Extra fields when `USER_ID` is an upload key type. */
  userIdInfo?: UserIdInfoProps;
};

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeResourceName = (value: string) =>
  value.replace(/\/+$/, "").trim();

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const accountIdOf = (value: string) =>
  lastSegment(value).replace(/-/g, "");

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const index = parts.lastIndexOf("userLists");
  if (index <= 0) return "";
  return parts.slice(0, index).join("/");
};

export const accountTypeOf = (parent: string) => {
  const parts = parent.split("/").filter((part) => part.length > 0);
  const index = parts.indexOf("accountTypes");
  if (index < 0 || parts[index + 1] === undefined) return DEFAULT_ACCOUNT_TYPE;
  return parts[index + 1]!;
};

export const accountOf = (parent: string) => {
  const parts = parent.split("/").filter((part) => part.length > 0);
  const index = parts.indexOf("accounts");
  if (index < 0 || parts[index + 1] === undefined) return "";
  return parts[index + 1]!;
};

export const resourceName = (parent: string, userListId: string) =>
  `${normalizeResourceName(parent)}/userLists/${userListId}`;

export const parentName = (accountType: string, account: string) => {
  const trimmed = normalizeResourceName(account);
  if (trimmed.includes("/accounts/")) return trimmed;
  return `accountTypes/${accountType}/accounts/${accountIdOf(trimmed)}`;
};

export const resolveParent = (input: {
  parent?: string;
  accountType?: string;
  account?: string;
}) => {
  if (input.parent && input.parent.length > 0) {
    return normalizeResourceName(input.parent);
  }
  if (input.account && input.account.length > 0) {
    return parentName(input.accountType ?? DEFAULT_ACCOUNT_TYPE, input.account);
  }
  return "";
};

export const replaceOnIdentity = (input: {
  previousParent?: string;
  nextParent: string;
  previousId?: string;
  nextId?: string;
  previousIngested?: unknown;
  nextIngested?: unknown;
}) => {
  if (
    input.previousParent !== undefined &&
    input.previousParent.length > 0 &&
    input.nextParent.length > 0 &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.nextIngested !== undefined &&
    input.previousIngested !== undefined &&
    !jsonEqual(input.previousIngested, input.nextIngested)
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const collectPages = <A, Page, E, R>(
  pages: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const ignoreMissing = <A, R>(
  effect: Effect.Effect<
    A,
    datamanager.DeleteAccountTypesAccountsUserListsError,
    R
  >,
) => effect.pipe(Effect.catchTag("NotFound", () => Effect.void));

export const getUserList = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : datamanager
        .getAccountTypesAccountsUserLists({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listUserLists = (parent: string) =>
  parent.length === 0
    ? emptyList<datamanager.UserList>()
    : collectPages(
        datamanager.listAccountTypesAccountsUserLists.pages({
          parent,
          pageSize: 200,
        }),
        (page) => page.userLists,
      ).pipe(
        // A missing account has no lists.
        Effect.catchTag("NotFound", () => emptyList<datamanager.UserList>()),
      );

export const findUserListByDisplayName = (
  displayName: string,
  parent: string,
) =>
  listUserLists(parent).pipe(
    Effect.map((rows) => rows.find((row) => row.displayName === displayName)),
  );

export const ingestedIdentity = (
  info: IngestedUserListInfoProps | undefined,
) => {
  if (info === undefined) return undefined;
  return {
    uploadKeyTypes: [...(info.uploadKeyTypes ?? [])].slice().sort(),
    partnerAudienceInfo: info.partnerAudienceInfo
      ? {
          partnerAudienceSource: info.partnerAudienceInfo.partnerAudienceSource,
          commercePartner: info.partnerAudienceInfo.commercePartner,
        }
      : undefined,
    mobileIdInfo: info.mobileIdInfo
      ? {
          keySpace: info.mobileIdInfo.keySpace,
          appId: info.mobileIdInfo.appId,
          dataSourceType: info.mobileIdInfo.dataSourceType,
        }
      : undefined,
    pairIdInfo: info.pairIdInfo
      ? {
          publisherId: info.pairIdInfo.publisherId,
          publisherName: info.pairIdInfo.publisherName,
          matchRatePercentage: info.pairIdInfo.matchRatePercentage,
          advertiserIdentifierCount: info.pairIdInfo.advertiserIdentifierCount,
          cleanRoomIdentifier: info.pairIdInfo.cleanRoomIdentifier,
        }
      : undefined,
    contactIdInfo: info.contactIdInfo
      ? { dataSourceType: info.contactIdInfo.dataSourceType }
      : undefined,
    userIdInfo: info.userIdInfo
      ? { dataSourceType: info.userIdInfo.dataSourceType }
      : undefined,
  };
};

export const ingestedFromRow = (
  info: datamanager.IngestedUserListInfo | undefined,
): IngestedUserListInfoProps | undefined => {
  if (info === undefined) return undefined;
  return {
    uploadKeyTypes: info.uploadKeyTypes,
    partnerAudienceInfo: info.partnerAudienceInfo
      ? {
          partnerAudienceSource: info.partnerAudienceInfo.partnerAudienceSource,
          commercePartner: info.partnerAudienceInfo.commercePartner,
        }
      : undefined,
    mobileIdInfo: info.mobileIdInfo
      ? {
          keySpace: info.mobileIdInfo.keySpace,
          appId: info.mobileIdInfo.appId,
          dataSourceType: info.mobileIdInfo.dataSourceType,
        }
      : undefined,
    pairIdInfo: info.pairIdInfo
      ? {
          publisherId: info.pairIdInfo.publisherId,
          matchRatePercentage: info.pairIdInfo.matchRatePercentage,
          publisherName: info.pairIdInfo.publisherName,
          advertiserIdentifierCount: info.pairIdInfo.advertiserIdentifierCount,
          cleanRoomIdentifier: info.pairIdInfo.cleanRoomIdentifier,
        }
      : undefined,
    contactIdInfo: info.contactIdInfo
      ? { dataSourceType: info.contactIdInfo.dataSourceType }
      : undefined,
    userIdInfo: info.userIdInfo
      ? { dataSourceType: info.userIdInfo.dataSourceType }
      : undefined,
  };
};

export const toIngestedBody = (
  info: IngestedUserListInfoProps | undefined,
): datamanager.IngestedUserListInfo => ({
  uploadKeyTypes: info?.uploadKeyTypes ?? DEFAULT_UPLOAD_KEY_TYPES,
  partnerAudienceInfo: info?.partnerAudienceInfo,
  mobileIdInfo: info?.mobileIdInfo,
  pairIdInfo: info?.pairIdInfo,
  contactIdInfo: info?.contactIdInfo,
  userIdInfo: info?.userIdInfo,
});
