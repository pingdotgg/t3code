import * as lf from "@distilled.cloud/aws/lakeformation";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { retryWhileInvalidPrincipal } from "./internal.ts";

/**
 * A principal/permissions pair used for database and table default
 * permissions.
 */
export interface DefaultPermissionSpec {
  /**
   * The principal (IAM ARN or the `IAM_ALLOWED_PRINCIPALS` group).
   */
  principal: string;
  /**
   * The permissions granted by default (e.g. `["ALL"]`).
   */
  permissions: lf.Permission[];
}

export interface DataLakeSettingsProps {
  /**
   * Principals to ensure are Lake Formation data lake administrators.
   * Managed additively: admins that already existed (or were added out of
   * band) are preserved; on destroy only the admins this resource added are
   * removed.
   */
  dataLakeAdmins?: string[];
  /**
   * Principals to ensure are read-only administrators. Managed additively,
   * like `dataLakeAdmins`.
   */
  readOnlyAdmins?: string[];
  /**
   * Default permissions applied to newly created databases. The prior value
   * is captured on first management and restored on destroy.
   */
  createDatabaseDefaultPermissions?: DefaultPermissionSpec[];
  /**
   * Default permissions applied to newly created tables. The prior value is
   * captured on first management and restored on destroy.
   */
  createTableDefaultPermissions?: DefaultPermissionSpec[];
  /**
   * Key/value parameters on the data lake settings (e.g.
   * `CROSS_ACCOUNT_VERSION`). Captured and restored like the default
   * permissions.
   */
  parameters?: Record<string, string>;
  /**
   * Account IDs whose resource shares are trusted.
   */
  trustedResourceOwners?: string[];
  /**
   * Allow external engines (EMR etc.) to filter data with Lake Formation
   * permissions.
   */
  allowExternalDataFiltering?: boolean;
  /**
   * Allow external engines full table access without session tags.
   */
  allowFullTableExternalDataAccess?: boolean;
  /**
   * Principals allowed to use external data filtering.
   */
  externalDataFilteringAllowList?: string[];
  /**
   * Session tag values authorized for external data filtering.
   */
  authorizedSessionTagValueList?: string[];
  /**
   * The catalog id (AWS account id) the settings apply to. Changing it
   * replaces the resource.
   * @default the caller's account
   */
  catalogId?: string;
}

/** Prop names whose prior values are captured and restored on destroy. */
export type ManagedField =
  | "createDatabaseDefaultPermissions"
  | "createTableDefaultPermissions"
  | "parameters"
  | "trustedResourceOwners"
  | "allowExternalDataFiltering"
  | "allowFullTableExternalDataAccess"
  | "externalDataFilteringAllowList"
  | "authorizedSessionTagValueList";

export interface DataLakeSettings extends Resource<
  "AWS.LakeFormation.DataLakeSettings",
  DataLakeSettingsProps,
  {
    catalogId: string;
    dataLakeAdmins: string[];
    readOnlyAdmins: string[];
    managedAdmins: string[];
    managedReadOnlyAdmins: string[];
    managedFields: ManagedField[];
    captured: lf.DataLakeSettings;
    /**
     * The live value of every field in `managedFields`, as observed. Lets
     * `alchemy drift` detect out-of-band changes.
     */
    managedSettings?: Partial<Record<ManagedField, unknown>>;
  },
  {},
  Providers
> {}

/**
 * The Lake Formation data lake settings for the account — an account/region
 * singleton controlling who the data lake administrators are, the default
 * permissions for new databases/tables, and external data filtering.
 *
 * The resource is capture-and-restore: the pre-existing settings are
 * snapshotted the first time it reconciles, admin lists are managed
 * additively (existing admins are never removed), and destroy puts back what
 * was there before for everything this resource managed.
 *
 * ### Managing Administrators
 * **Example:** Add a Data Lake Administrator
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 *
 * const settings = yield* AWS.LakeFormation.DataLakeSettings("Settings", {
 *   dataLakeAdmins: [adminRole.roleArn],
 * });
 * ```
 *
 * ### Default Permissions
 * **Example:** Disable IAM-Allowed-Principals Defaults
 * ```typescript
 * const settings = yield* AWS.LakeFormation.DataLakeSettings("Settings", {
 *   dataLakeAdmins: [adminRole.roleArn],
 *   createDatabaseDefaultPermissions: [],
 *   createTableDefaultPermissions: [],
 * });
 * ```
 *
 * @resource
 */
export const DataLakeSettings = Resource<DataLakeSettings>("AWS.LakeFormation.DataLakeSettings");

const principalIds = (principals: lf.DataLakePrincipal[] | undefined): string[] =>
  (principals ?? [])
    .map((p) => p.DataLakePrincipalIdentifier)
    .filter((id): id is string => id !== undefined);

const toPrincipals = (ids: string[]): lf.DataLakePrincipal[] =>
  ids.map((id) => ({ DataLakePrincipalIdentifier: id }));

const toWireDefaults = (specs: DefaultPermissionSpec[]): lf.PrincipalPermissions[] =>
  specs.map((s) => ({
    Principal: { DataLakePrincipalIdentifier: s.principal },
    Permissions: s.permissions,
  }));

const dedupe = (values: string[]): string[] => [...new Set(values)];

/**
 * Stable fingerprint of the aspects of the settings this resource manages —
 * used to skip the `PutDataLakeSettings` call when nothing changed.
 */
const fingerprint = (s: lf.DataLakeSettings): string =>
  JSON.stringify({
    admins: principalIds(s.DataLakeAdmins).sort(),
    readOnlyAdmins: principalIds(s.ReadOnlyAdmins).sort(),
    createDb: (s.CreateDatabaseDefaultPermissions ?? []).map((p) => ({
      principal: p.Principal?.DataLakePrincipalIdentifier,
      permissions: [...(p.Permissions ?? [])].sort(),
    })),
    createTable: (s.CreateTableDefaultPermissions ?? []).map((p) => ({
      principal: p.Principal?.DataLakePrincipalIdentifier,
      permissions: [...(p.Permissions ?? [])].sort(),
    })),
    parameters: Object.entries(s.Parameters ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    trusted: [...(s.TrustedResourceOwners ?? [])].sort(),
    allowExternal: s.AllowExternalDataFiltering ?? false,
    allowFullTable: s.AllowFullTableExternalDataAccess ?? false,
    allowList: principalIds(s.ExternalDataFilteringAllowList).sort(),
    sessionTags: [...(s.AuthorizedSessionTagValueList ?? [])].sort(),
  });

/**
 * The live value of each managed field, normalized for comparison. `read`
 * and `reconcile` share it so converged settings read unchanged.
 */
const observeManagedSettings = (
  s: lf.DataLakeSettings,
  fields: readonly ManagedField[],
): Partial<Record<ManagedField, unknown>> => {
  const defaults = (permissions: lf.PrincipalPermissions[] | undefined) =>
    (permissions ?? [])
      .map((p) => ({
        principal: p.Principal?.DataLakePrincipalIdentifier,
        permissions: [...(p.Permissions ?? [])].sort(),
      }))
      .sort((a, b) => (a.principal ?? "").localeCompare(b.principal ?? ""));
  const value = (field: ManagedField): unknown => {
    switch (field) {
      case "createDatabaseDefaultPermissions":
        return defaults(s.CreateDatabaseDefaultPermissions);
      case "createTableDefaultPermissions":
        return defaults(s.CreateTableDefaultPermissions);
      case "parameters":
        return Object.fromEntries(
          Object.entries(s.Parameters ?? {}).filter(([, v]) => v !== undefined),
        );
      case "trustedResourceOwners":
        return [...(s.TrustedResourceOwners ?? [])].sort();
      case "allowExternalDataFiltering":
        return s.AllowExternalDataFiltering ?? false;
      case "allowFullTableExternalDataAccess":
        return s.AllowFullTableExternalDataAccess ?? false;
      case "externalDataFilteringAllowList":
        return principalIds(s.ExternalDataFilteringAllowList).sort();
      case "authorizedSessionTagValueList":
        return [...(s.AuthorizedSessionTagValueList ?? [])].sort();
    }
  };
  return Object.fromEntries(fields.map((field) => [field, value(field)]));
};

/** Plain JSON snapshot of the observed settings for capture-and-restore. */
const snapshot = (s: lf.DataLakeSettings): lf.DataLakeSettings =>
  JSON.parse(JSON.stringify(s)) as lf.DataLakeSettings;

const MANAGED_FIELDS: ManagedField[] = [
  "createDatabaseDefaultPermissions",
  "createTableDefaultPermissions",
  "parameters",
  "trustedResourceOwners",
  "allowExternalDataFiltering",
  "allowFullTableExternalDataAccess",
  "externalDataFilteringAllowList",
  "authorizedSessionTagValueList",
];

/** Copy one managed field's wire value from `source` onto `target`. */
const copyField = (
  target: lf.DataLakeSettings,
  source: lf.DataLakeSettings,
  field: ManagedField,
): void => {
  switch (field) {
    case "createDatabaseDefaultPermissions":
      target.CreateDatabaseDefaultPermissions = source.CreateDatabaseDefaultPermissions;
      break;
    case "createTableDefaultPermissions":
      target.CreateTableDefaultPermissions = source.CreateTableDefaultPermissions;
      break;
    case "parameters":
      target.Parameters = source.Parameters;
      break;
    case "trustedResourceOwners":
      target.TrustedResourceOwners = source.TrustedResourceOwners;
      break;
    case "allowExternalDataFiltering":
      target.AllowExternalDataFiltering = source.AllowExternalDataFiltering;
      break;
    case "allowFullTableExternalDataAccess":
      target.AllowFullTableExternalDataAccess = source.AllowFullTableExternalDataAccess;
      break;
    case "externalDataFilteringAllowList":
      target.ExternalDataFilteringAllowList = source.ExternalDataFilteringAllowList;
      break;
    case "authorizedSessionTagValueList":
      target.AuthorizedSessionTagValueList = source.AuthorizedSessionTagValueList;
      break;
  }
};

/** Apply a desired prop value for one managed field onto `target`. */
const applyField = (
  target: lf.DataLakeSettings,
  news: DataLakeSettingsProps,
  field: ManagedField,
): void => {
  switch (field) {
    case "createDatabaseDefaultPermissions":
      target.CreateDatabaseDefaultPermissions = toWireDefaults(
        news.createDatabaseDefaultPermissions!,
      );
      break;
    case "createTableDefaultPermissions":
      target.CreateTableDefaultPermissions = toWireDefaults(news.createTableDefaultPermissions!);
      break;
    case "parameters":
      target.Parameters = news.parameters;
      break;
    case "trustedResourceOwners":
      target.TrustedResourceOwners = news.trustedResourceOwners;
      break;
    case "allowExternalDataFiltering":
      target.AllowExternalDataFiltering = news.allowExternalDataFiltering;
      break;
    case "allowFullTableExternalDataAccess":
      target.AllowFullTableExternalDataAccess = news.allowFullTableExternalDataAccess;
      break;
    case "externalDataFilteringAllowList":
      target.ExternalDataFilteringAllowList = toPrincipals(news.externalDataFilteringAllowList!);
      break;
    case "authorizedSessionTagValueList":
      target.AuthorizedSessionTagValueList = news.authorizedSessionTagValueList;
      break;
  }
};

export const DataLakeSettingsProvider = () =>
  Provider.effect(
    DataLakeSettings,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (catalogId: string | undefined) {
        const response = yield* lf.getDataLakeSettings({
          CatalogId: catalogId,
        });
        return response.DataLakeSettings ?? {};
      });

      /**
       * Merge managed admins into the observed list: keep everything
       * observed except principals we previously managed and no longer
       * manage (unless they were admins before we ever touched the
       * settings), then union with the currently-managed set.
       */
      const mergeAdmins = (input: {
        observed: string[];
        managed: string[];
        previouslyManaged: string[];
        captured: string[];
      }): string[] => {
        const removedByUs = input.previouslyManaged.filter((p) => !input.managed.includes(p));
        return dedupe([
          ...input.observed.filter((p) => !removedByUs.includes(p) || input.captured.includes(p)),
          ...input.managed,
        ]);
      };

      return DataLakeSettings.Provider.of({
        stables: ["catalogId"],

        // Account/region singleton — return the single instance.
        list: () =>
          Effect.gen(function* () {
            const observed = yield* observe(undefined);
            const { accountId } = yield* AWSEnvironment.current;
            return [
              {
                catalogId: accountId,
                dataLakeAdmins: principalIds(observed.DataLakeAdmins),
                readOnlyAdmins: principalIds(observed.ReadOnlyAdmins),
                managedAdmins: [],
                managedReadOnlyAdmins: [],
                managedFields: [] as ManagedField[],
                captured: snapshot(observed),
              },
            ];
          }),

        read: Effect.fn(function* ({ olds, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const catalogId = output?.catalogId ?? olds?.catalogId ?? accountId;
          const observed = yield* observe(olds?.catalogId);
          return {
            catalogId,
            dataLakeAdmins: principalIds(observed.DataLakeAdmins),
            readOnlyAdmins: principalIds(observed.ReadOnlyAdmins),
            managedAdmins: output?.managedAdmins ?? [],
            managedReadOnlyAdmins: output?.managedReadOnlyAdmins ?? [],
            managedFields: output?.managedFields ?? [],
            captured: output?.captured ?? snapshot(observed),
            managedSettings: observeManagedSettings(observed, output?.managedFields ?? []),
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if ((news.catalogId ?? undefined) !== (olds.catalogId ?? undefined)) {
            return { action: "replace" } as const;
          }
          // everything else → update (singleton sync)
        }),

        reconcile: Effect.fn(function* ({ news, olds, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const catalogId = news.catalogId ?? accountId;

          // 1. OBSERVE — cloud settings are authoritative; capture the
          //    pre-existing settings the first time we manage them.
          const observed = yield* observe(news.catalogId);
          const captured = output?.captured ?? snapshot(observed);

          // 2. SYNC — start from observed, overlay the aspects we manage.
          const desired = snapshot(observed);

          const managedAdmins = news.dataLakeAdmins ?? [];
          const managedReadOnlyAdmins = news.readOnlyAdmins ?? [];
          desired.DataLakeAdmins = toPrincipals(
            mergeAdmins({
              observed: principalIds(observed.DataLakeAdmins),
              managed: managedAdmins,
              previouslyManaged: olds?.dataLakeAdmins ?? [],
              captured: principalIds(captured.DataLakeAdmins),
            }),
          );
          desired.ReadOnlyAdmins = toPrincipals(
            mergeAdmins({
              observed: principalIds(observed.ReadOnlyAdmins),
              managed: managedReadOnlyAdmins,
              previouslyManaged: olds?.readOnlyAdmins ?? [],
              captured: principalIds(captured.ReadOnlyAdmins),
            }),
          );

          const managedFields = MANAGED_FIELDS.filter((field) => news[field] !== undefined);
          for (const field of MANAGED_FIELDS) {
            if (news[field] !== undefined) {
              applyField(desired, news, field);
            } else if (olds?.[field] !== undefined) {
              // field was managed before and is no longer — restore the
              // captured pre-management value.
              copyField(desired, captured, field);
            }
          }

          if (fingerprint(desired) !== fingerprint(observed)) {
            yield* lf
              .putDataLakeSettings({
                CatalogId: news.catalogId,
                DataLakeSettings: desired,
              })
              .pipe(retryWhileInvalidPrincipal);
            yield* session.note("Updated data lake settings");
          }

          return {
            catalogId,
            dataLakeAdmins: principalIds(desired.DataLakeAdmins),
            readOnlyAdmins: principalIds(desired.ReadOnlyAdmins),
            managedAdmins,
            managedReadOnlyAdmins,
            managedFields,
            captured,
            managedSettings: observeManagedSettings(desired, managedFields),
          };
        }),

        delete: Effect.fn(function* ({ output, session }) {
          // Restore: remove the admins we added (unless they were already
          // admins before we managed the settings) and put back the captured
          // values for every field we managed.
          const catalogIdInput = output.catalogId === undefined ? undefined : output.catalogId;
          const observed = yield* observe(catalogIdInput);
          const captured = output.captured;
          const desired = snapshot(observed);

          const capturedAdmins = principalIds(captured.DataLakeAdmins);
          desired.DataLakeAdmins = toPrincipals(
            principalIds(observed.DataLakeAdmins).filter(
              (p) => !output.managedAdmins.includes(p) || capturedAdmins.includes(p),
            ),
          );
          const capturedReadOnly = principalIds(captured.ReadOnlyAdmins);
          desired.ReadOnlyAdmins = toPrincipals(
            principalIds(observed.ReadOnlyAdmins).filter(
              (p) => !output.managedReadOnlyAdmins.includes(p) || capturedReadOnly.includes(p),
            ),
          );

          for (const field of output.managedFields) {
            copyField(desired, captured, field);
          }

          if (fingerprint(desired) !== fingerprint(observed)) {
            yield* lf
              .putDataLakeSettings({
                CatalogId: catalogIdInput,
                DataLakeSettings: desired,
              })
              .pipe(retryWhileInvalidPrincipal);
            yield* session.note("Restored data lake settings");
          }
        }),
      });
    }),
  );
