import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  OracleDatabaseNotResolved,
  collectPages,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceNameOf,
  retryConflict,
  retryQuota,
  toPhysicalId,
  userLabels,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "exascaleDbStorageVaults";
const FALLBACK_ID = "exavault";

export type ExascaleDbStorageDetails = {
  /** Total storage allocation in GB. Required on create. */
  totalSizeGbs?: number;
};

export type ExascaleDbStorageVaultPropertiesInput = {
  /** Additional flash cache as a percent of high-capacity storage. */
  additionalFlashCachePercent?: number;
  /** Storage details. Required on create. */
  exascaleDbStorageDetails?: ExascaleDbStorageDetails;
  /** Vault description. */
  description?: string;
};

export type ExascaleDbStorageVaultProps = {
  /**
   * Vault id. If omitted, a unique RFC1035 name is generated. Immutable.
   */
  exascaleDbStorageVaultId?: string;
  /**
   * Region. Immutable.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Required on create.
   */
  displayName?: string;
  /**
   * GCP Oracle zone. Immutable.
   */
  gcpOracleZone?: string;
  /**
   * Exadata Infrastructure this vault is created on. Immutable.
   */
  exadataInfrastructure?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Vault properties.
   */
  properties?: ExascaleDbStorageVaultPropertiesInput;
  /** Total size in GB. Convenience alias. */
  totalSizeGbs?: number;
  /** Vault description. Convenience alias. */
  description?: string;
};

export type ExascaleDbStorageVault = Resource<
  "GCP.OracleDatabase.ExascaleDbStorageVault",
  ExascaleDbStorageVaultProps,
  {
    /** Full resource name. */
    name: string;
    /** Vault id. */
    exascaleDbStorageVaultId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** GCP Oracle zone. */
    gcpOracleZone: string | undefined;
    /** Exadata Infrastructure. */
    exadataInfrastructure: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Entitlement id. */
    entitlementId: string | undefined;
    /** Lifecycle state. */
    state: string | undefined;
    /** Total size in GB. */
    totalSizeGbs: number | undefined;
    /** Available size in GB. */
    availableSizeGbs: number | undefined;
    /** Description. */
    description: string | undefined;
    /** OCID. */
    ocid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Oracle Exascale DB storage vault on Google Cloud.
 *
 * Changing `exascaleDbStorageVaultId`, `location`,
 * `exadataInfrastructure`, or `gcpOracleZone` replaces the vault. There
 * is no patch API in the distilled SDK, so labels are applied at create.
 *
 * ### Creating a storage vault
 * **Example:** Generated name
 * ```typescript
 * const vault = yield* GCP.OracleDatabase.ExascaleDbStorageVault("Vault", {
 *   displayName: "vault",
 *   totalSizeGbs: 300,
 * });
 * ```
 *
 * @resource
 * @category OracleDatabase
 */
export const ExascaleDbStorageVault = Resource<ExascaleDbStorageVault>(
  "GCP.OracleDatabase.ExascaleDbStorageVault",
);

const mergedProperties = (
  news: ExascaleDbStorageVaultProps,
): ExascaleDbStorageVaultPropertiesInput => ({
  ...(news.properties ?? {}),
  description: news.description ?? news.properties?.description,
  exascaleDbStorageDetails: {
    ...(news.properties?.exascaleDbStorageDetails ?? {}),
    totalSizeGbs:
      news.totalSizeGbs ??
      news.properties?.exascaleDbStorageDetails?.totalSizeGbs,
  },
});

const toCreateBody = (
  news: ExascaleDbStorageVaultProps,
  desiredLabels: Record<string, string>,
): oracle.ExascaleDbStorageVault => {
  const props = mergedProperties(news);
  const properties: oracle.ExascaleDbStorageVaultProperties = {};
  if (props.additionalFlashCachePercent !== undefined) {
    properties.additionalFlashCachePercent = props.additionalFlashCachePercent;
  }
  if (props.exascaleDbStorageDetails !== undefined) {
    properties.exascaleDbStorageDetails = props.exascaleDbStorageDetails;
  }
  if (props.description !== undefined)
    properties.description = props.description;
  const body: oracle.ExascaleDbStorageVault = {
    labels: desiredLabels,
    properties,
  };
  if (news.displayName !== undefined) body.displayName = news.displayName;
  if (news.gcpOracleZone !== undefined) body.gcpOracleZone = news.gcpOracleZone;
  if (news.exadataInfrastructure !== undefined) {
    body.exadataInfrastructure = news.exadataInfrastructure;
  }
  return body;
};

const toAttrs = (vault: oracle.ExascaleDbStorageVault, project: string) => {
  const name = vault.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    exascaleDbStorageVaultId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: vault.displayName,
    gcpOracleZone: vault.gcpOracleZone,
    exadataInfrastructure: vault.exadataInfrastructure,
    labels: userLabels(vault.labels),
    entitlementId: vault.entitlementId,
    state: vault.properties?.state,
    totalSizeGbs: vault.properties?.exascaleDbStorageDetails?.totalSizeGbs,
    availableSizeGbs:
      vault.properties?.exascaleDbStorageDetails?.availableSizeGbs,
    description: vault.properties?.description,
    ocid: vault.properties?.ocid,
    createTime: vault.createTime,
  };
};

const getByName = (name: string) =>
  retryQuota(oracle.getProjectsLocationsExascaleDbStorageVaults({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listVaults = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      oracle.listProjectsLocationsExascaleDbStorageVaults.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.exascaleDbStorageVaults,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
    );
  return listAtLocation(project, region, collect).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );
};

export const ExascaleDbStorageVaultProvider = () =>
  Provider.succeed(ExascaleDbStorageVault, {
    stables: [
      "name",
      "exascaleDbStorageVaultId",
      "project",
      "location",
      "createTime",
      "ocid",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousInfra =
        olds?.exadataInfrastructure ?? output?.exadataInfrastructure ?? "";
      const nextInfra = news.exadataInfrastructure ?? previousInfra;
      const previousZone = olds?.gcpOracleZone ?? output?.gcpOracleZone ?? "";
      const nextZone = news.gcpOracleZone ?? previousZone;
      return replaceOnIdentity({
        previousId:
          olds?.exascaleDbStorageVaultId ?? output?.exascaleDbStorageVaultId,
        nextId:
          news.exascaleDbStorageVaultId ??
          olds?.exascaleDbStorageVaultId ??
          output?.exascaleDbStorageVaultId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra: nextInfra !== previousInfra || nextZone !== previousZone,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const exascaleDbStorageVaultId = yield* toPhysicalId(
        id,
        olds?.exascaleDbStorageVaultId,
        output?.exascaleDbStorageVaultId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceNameOf(
          env.project,
          location,
          COLLECTION,
          exascaleDbStorageVaultId,
        );
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listVaults(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const exascaleDbStorageVaultId = yield* toPhysicalId(
        id,
        news.exascaleDbStorageVaultId,
        output?.exascaleDbStorageVaultId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceNameOf(
        env.project,
        location,
        COLLECTION,
        exascaleDbStorageVaultId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* oracle
          .createProjectsLocationsExascaleDbStorageVaults({
            parent: parentOf(env.project, location),
            exascaleDbStorageVaultId,
            body: toCreateBody(news, desiredLabels),
          })
          .pipe(
            retryQuota,
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new OracleDatabaseNotResolved({ name });
      }

      const ready = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (value) => value.properties?.state,
      );

      return toAttrs(ready, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* oracle
        .deleteProjectsLocationsExascaleDbStorageVaults({
          name: output.name,
        })
        .pipe(
          retryConflict,
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
