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
  type CustomerContact,
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

const COLLECTION = "cloudExadataInfrastructures";
const FALLBACK_ID = "exadata";

export type MaintenanceWindow = {
  /** Scheduling preference (`CUSTOM_PREFERENCE`, `NO_PREFERENCE`). */
  preference?: oracle.MaintenanceWindowPreferenceEnum | (string & {});
  /** 4-hour UTC slots (`0`, `4`, `8`, `12`, `16`, `20`). */
  hoursOfDay?: number[];
  /** Custom action timeout in minutes (15-120). */
  customActionTimeoutMins?: number;
  /** Months when maintenance should run. */
  months?: Array<oracle.MaintenanceWindowMonthsItemEnum | (string & {})>;
  /** Patching mode (`ROLLING`, `NONROLLING`). */
  patchingMode?: oracle.MaintenanceWindowPatchingModeEnum | (string & {});
  /** Lead time in weeks (1-4). */
  leadTimeWeek?: number;
  /** Days of week. */
  daysOfWeek?: Array<
    oracle.MaintenanceWindowDaysOfWeekItemEnum | (string & {})
  >;
  /** Enable custom action timeout. */
  isCustomActionTimeoutEnabled?: boolean;
  /** Weeks of month (1, 2, 3, 4). */
  weeksOfMonth?: number[];
};

export type CloudExadataInfrastructurePropertiesInput = {
  /** Shape (e.g. `Exadata.X9M`). Immutable. */
  shape?: string;
  /** Number of compute servers. */
  computeCount?: number;
  /** Number of storage servers. */
  storageCount?: number;
  /** Total storage size in GB. */
  totalStorageSizeGb?: number;
  /** Maintenance window. */
  maintenanceWindow?: MaintenanceWindow;
  /** Customer contacts. */
  customerContacts?: CustomerContact[];
};

export type CloudExadataInfrastructureProps = {
  /**
   * Exadata Infrastructure id (the `{cloud_exadata_infrastructure}`
   * segment). If omitted, a unique RFC1035 name is generated. Immutable.
   */
  cloudExadataInfrastructureId?: string;
  /**
   * Region. Immutable.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * GCP Oracle zone (e.g. `us-east4-b-r2`). Immutable. If omitted the
   * service picks a zone.
   */
  gcpOracleZone?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Infrastructure properties. `shape` is required on create.
   */
  properties?: CloudExadataInfrastructurePropertiesInput;
  /** Shape. Convenience alias for `properties.shape`. */
  shape?: string;
  /** Compute server count. Convenience alias for `properties.computeCount`. */
  computeCount?: number;
  /** Storage server count. Convenience alias for `properties.storageCount`. */
  storageCount?: number;
};

export type CloudExadataInfrastructure = Resource<
  "GCP.OracleDatabase.CloudExadataInfrastructure",
  CloudExadataInfrastructureProps,
  {
    /** Full resource name. */
    name: string;
    /** Infrastructure id. */
    cloudExadataInfrastructureId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** GCP Oracle zone. */
    gcpOracleZone: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Entitlement id. */
    entitlementId: string | undefined;
    /** Lifecycle state. */
    state: string | undefined;
    /** Shape. */
    shape: string | undefined;
    /** Compute server count. */
    computeCount: number | undefined;
    /** Storage server count. */
    storageCount: number | undefined;
    /** OCID. */
    ocid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Oracle Exadata Infrastructure on Google Cloud.
 *
 * Changing `cloudExadataInfrastructureId`, `location`, `gcpOracleZone`,
 * or `shape` replaces the infrastructure. There is no patch API in the
 * distilled SDK, so labels and counts are applied at create.
 *
 * Provisioning typically takes tens of minutes and requires an Oracle
 * Database@Google Cloud entitlement. Delete sends `force=true` so child
 * VM clusters do not block teardown.
 *
 * ### Creating Exadata Infrastructure
 * **Example:** Generated name
 * ```typescript
 * const infra = yield* GCP.OracleDatabase.CloudExadataInfrastructure("Exa", {
 *   displayName: "exa",
 *   shape: "Exadata.X9M",
 *   computeCount: 2,
 *   storageCount: 3,
 * });
 * ```
 *
 * @resource
 * @category OracleDatabase
 */
export const CloudExadataInfrastructure = Resource<CloudExadataInfrastructure>(
  "GCP.OracleDatabase.CloudExadataInfrastructure",
);

const mergedProperties = (
  news: CloudExadataInfrastructureProps,
): CloudExadataInfrastructurePropertiesInput => ({
  ...(news.properties ?? {}),
  shape: news.shape ?? news.properties?.shape,
  computeCount: news.computeCount ?? news.properties?.computeCount,
  storageCount: news.storageCount ?? news.properties?.storageCount,
});

const toCreateBody = (
  news: CloudExadataInfrastructureProps,
  desiredLabels: Record<string, string>,
): oracle.CloudExadataInfrastructure => {
  const props = mergedProperties(news);
  const properties: oracle.CloudExadataInfrastructureProperties = {};
  if (props.shape !== undefined) properties.shape = props.shape;
  if (props.computeCount !== undefined) {
    properties.computeCount = props.computeCount;
  }
  if (props.storageCount !== undefined) {
    properties.storageCount = props.storageCount;
  }
  if (props.totalStorageSizeGb !== undefined) {
    properties.totalStorageSizeGb = props.totalStorageSizeGb;
  }
  if (props.maintenanceWindow !== undefined) {
    properties.maintenanceWindow = props.maintenanceWindow;
  }
  if (props.customerContacts !== undefined) {
    properties.customerContacts = props.customerContacts;
  }
  const body: oracle.CloudExadataInfrastructure = {
    labels: desiredLabels,
    properties,
  };
  if (news.displayName !== undefined) body.displayName = news.displayName;
  if (news.gcpOracleZone !== undefined) {
    body.gcpOracleZone = news.gcpOracleZone;
  }
  return body;
};

const toAttrs = (infra: oracle.CloudExadataInfrastructure, project: string) => {
  const name = infra.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    cloudExadataInfrastructureId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: infra.displayName,
    gcpOracleZone: infra.gcpOracleZone,
    labels: userLabels(infra.labels),
    entitlementId: infra.entitlementId,
    state: infra.properties?.state,
    shape: infra.properties?.shape,
    computeCount: infra.properties?.computeCount,
    storageCount: infra.properties?.storageCount,
    ocid: infra.properties?.ocid,
    createTime: infra.createTime,
  };
};

const getByName = (name: string) =>
  retryQuota(
    oracle.getProjectsLocationsCloudExadataInfrastructures({ name }),
  ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listInfras = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      oracle.listProjectsLocationsCloudExadataInfrastructures.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.cloudExadataInfrastructures,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
    );
  return listAtLocation(project, region, collect).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );
};

export const CloudExadataInfrastructureProvider = () =>
  Provider.succeed(CloudExadataInfrastructure, {
    stables: [
      "name",
      "cloudExadataInfrastructureId",
      "project",
      "location",
      "createTime",
      "ocid",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const props = mergedProperties(news);
      const previousShape =
        olds?.shape ?? olds?.properties?.shape ?? output?.shape ?? "";
      const nextShape = props.shape ?? previousShape;
      const previousZone = olds?.gcpOracleZone ?? output?.gcpOracleZone ?? "";
      const nextZone = news.gcpOracleZone ?? previousZone;
      return replaceOnIdentity({
        previousId:
          olds?.cloudExadataInfrastructureId ??
          output?.cloudExadataInfrastructureId,
        nextId:
          news.cloudExadataInfrastructureId ??
          olds?.cloudExadataInfrastructureId ??
          output?.cloudExadataInfrastructureId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra: nextShape !== previousShape || nextZone !== previousZone,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const cloudExadataInfrastructureId = yield* toPhysicalId(
        id,
        olds?.cloudExadataInfrastructureId,
        output?.cloudExadataInfrastructureId,
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
          cloudExadataInfrastructureId,
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
        const items = yield* listInfras(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const cloudExadataInfrastructureId = yield* toPhysicalId(
        id,
        news.cloudExadataInfrastructureId,
        output?.cloudExadataInfrastructureId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceNameOf(
        env.project,
        location,
        COLLECTION,
        cloudExadataInfrastructureId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* oracle
          .createProjectsLocationsCloudExadataInfrastructures({
            parent: parentOf(env.project, location),
            cloudExadataInfrastructureId,
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
        .deleteProjectsLocationsCloudExadataInfrastructures({
          name: output.name,
          force: true,
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
