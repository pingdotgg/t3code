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
  type TimeZone,
  toPhysicalId,
  userLabels,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "dbSystems";
const FALLBACK_ID = "dbsystem";

export type DbHome = {
  /** Enable unified auditing. */
  isUnifiedAuditingEnabled?: boolean;
  /** Database Home display name. */
  displayName?: string;
  /** Oracle Database version. */
  dbVersion?: string;
  /** Database resource created in the home. */
  database?: oracle.Database;
};

export type DbSystemOptions = {
  /** Storage management (`ASM`, `LVM`). */
  storageManagement?:
    | oracle.DbSystemOptionsStorageManagementEnum
    | (string & {});
};

export type DataCollectionOptionsDbSystem = {
  /** Enable incident logs and traces. */
  isIncidentLogsEnabled?: boolean;
  /** Enable diagnostics events. */
  isDiagnosticsEventsEnabled?: boolean;
};

export type DbSystemPropertiesInput = {
  /** Shape. Required on create. */
  shape?: string;
  /** SSH public keys. Required on create. */
  sshPublicKeys?: string[];
  /** Initial data storage size in GB. Required on create. */
  initialDataStorageSizeGb?: number;
  /** CPU cores. Required on create. */
  computeCount?: number;
  /** License model. Required on create. */
  licenseModel?: oracle.DbSystemPropertiesLicenseModelEnum | (string & {});
  /** Database edition. Required on create. */
  databaseEdition?:
    | oracle.DbSystemPropertiesDatabaseEditionEnum
    | (string & {});
  /** Hostname prefix. */
  hostnamePrefix?: string;
  /** Time zone. */
  timeZone?: TimeZone;
  /** Database Home. */
  dbHome?: DbHome;
  /** Private IP. */
  privateIp?: string;
  /** DbSystem options. */
  dbSystemOptions?: DbSystemOptions;
  /** Reco/redo storage size in GB. */
  recoStorageSizeGb?: number;
  /** Host domain. */
  domain?: string;
  /** Memory in GB. */
  memorySizeGb?: number;
  /** Diagnostics collection. */
  dataCollectionOptions?: DataCollectionOptionsDbSystem;
  /** Node count. */
  nodeCount?: number;
  /** Compute model (`ECPU`, `OCPU`). */
  computeModel?: oracle.DbSystemPropertiesComputeModelEnum | (string & {});
};

export type DbSystemProps = {
  /**
   * DbSystem id. If omitted, a unique RFC1035 name is generated.
   * Immutable.
   */
  dbSystemId?: string;
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
   * ODB Network. Immutable.
   */
  odbNetwork?: string;
  /**
   * ODB Subnet for IP allocation. Required on create. Immutable.
   */
  odbSubnet?: string;
  /**
   * GCP Oracle zone. Immutable.
   */
  gcpOracleZone?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * DbSystem properties.
   */
  properties?: DbSystemPropertiesInput;
  /** Shape. Convenience alias for `properties.shape`. */
  shape?: string;
  /** SSH public keys. Convenience alias for `properties.sshPublicKeys`. */
  sshPublicKeys?: string[];
  /** CPU cores. Convenience alias for `properties.computeCount`. */
  computeCount?: number;
  /** License model. Convenience alias for `properties.licenseModel`. */
  licenseModel?: oracle.DbSystemPropertiesLicenseModelEnum | (string & {});
  /** Database edition. Convenience alias for `properties.databaseEdition`. */
  databaseEdition?:
    | oracle.DbSystemPropertiesDatabaseEditionEnum
    | (string & {});
  /** Initial data storage in GB. Convenience alias. */
  initialDataStorageSizeGb?: number;
};

export type DbSystem = Resource<
  "GCP.OracleDatabase.DbSystem",
  DbSystemProps,
  {
    /** Full resource name. */
    name: string;
    /** DbSystem id. */
    dbSystemId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** ODB Network. */
    odbNetwork: string | undefined;
    /** ODB Subnet. */
    odbSubnet: string | undefined;
    /** GCP Oracle zone. */
    gcpOracleZone: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Entitlement id. */
    entitlementId: string | undefined;
    /** Lifecycle state. */
    lifecycleState: string | undefined;
    /** Shape. */
    shape: string | undefined;
    /** Hostname. */
    hostname: string | undefined;
    /** OCID. */
    ocid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Oracle BaseDB system on Google Cloud.
 *
 * Changing `dbSystemId`, `location`, `odbSubnet`, `odbNetwork`, `shape`,
 * or `gcpOracleZone` replaces the system. There is no patch API in the
 * distilled SDK, so labels are applied at create.
 *
 * ### Creating a DbSystem
 * **Example:** Generated name
 * ```typescript
 * const db = yield* GCP.OracleDatabase.DbSystem("BaseDb", {
 *   displayName: "basedb",
 *   odbSubnet: subnet.name,
 *   shape: "VM.Standard.E4.Flex",
 *   sshPublicKeys: [publicKey],
 *   computeCount: 2,
 *   initialDataStorageSizeGb: 256,
 *   licenseModel: "LICENSE_INCLUDED",
 *   databaseEdition: "ENTERPRISE_EDITION",
 * });
 * ```
 *
 * @resource
 * @category OracleDatabase
 */
export const DbSystem = Resource<DbSystem>("GCP.OracleDatabase.DbSystem");

const mergedProperties = (news: DbSystemProps): DbSystemPropertiesInput => ({
  ...(news.properties ?? {}),
  shape: news.shape ?? news.properties?.shape,
  sshPublicKeys: news.sshPublicKeys ?? news.properties?.sshPublicKeys,
  computeCount: news.computeCount ?? news.properties?.computeCount,
  licenseModel: news.licenseModel ?? news.properties?.licenseModel,
  databaseEdition: news.databaseEdition ?? news.properties?.databaseEdition,
  initialDataStorageSizeGb:
    news.initialDataStorageSizeGb ?? news.properties?.initialDataStorageSizeGb,
});

const toCreateBody = (
  news: DbSystemProps,
  desiredLabels: Record<string, string>,
): oracle.DbSystem => {
  const props = mergedProperties(news);
  const properties: oracle.DbSystemProperties = {};
  if (props.shape !== undefined) properties.shape = props.shape;
  if (props.sshPublicKeys !== undefined) {
    properties.sshPublicKeys = props.sshPublicKeys;
  }
  if (props.initialDataStorageSizeGb !== undefined) {
    properties.initialDataStorageSizeGb = props.initialDataStorageSizeGb;
  }
  if (props.computeCount !== undefined) {
    properties.computeCount = props.computeCount;
  }
  if (props.licenseModel !== undefined) {
    properties.licenseModel = props.licenseModel;
  }
  if (props.databaseEdition !== undefined) {
    properties.databaseEdition = props.databaseEdition;
  }
  if (props.hostnamePrefix !== undefined) {
    properties.hostnamePrefix = props.hostnamePrefix;
  }
  if (props.timeZone !== undefined) properties.timeZone = props.timeZone;
  if (props.dbHome !== undefined) properties.dbHome = props.dbHome;
  if (props.privateIp !== undefined) properties.privateIp = props.privateIp;
  if (props.dbSystemOptions !== undefined) {
    properties.dbSystemOptions = props.dbSystemOptions;
  }
  if (props.recoStorageSizeGb !== undefined) {
    properties.recoStorageSizeGb = props.recoStorageSizeGb;
  }
  if (props.domain !== undefined) properties.domain = props.domain;
  if (props.memorySizeGb !== undefined) {
    properties.memorySizeGb = props.memorySizeGb;
  }
  if (props.dataCollectionOptions !== undefined) {
    properties.dataCollectionOptions = props.dataCollectionOptions;
  }
  if (props.nodeCount !== undefined) properties.nodeCount = props.nodeCount;
  if (props.computeModel !== undefined) {
    properties.computeModel = props.computeModel;
  }
  const body: oracle.DbSystem = {
    labels: desiredLabels,
    properties,
  };
  if (news.displayName !== undefined) body.displayName = news.displayName;
  if (news.odbNetwork !== undefined) body.odbNetwork = news.odbNetwork;
  if (news.odbSubnet !== undefined) body.odbSubnet = news.odbSubnet;
  if (news.gcpOracleZone !== undefined) body.gcpOracleZone = news.gcpOracleZone;
  return body;
};

const toAttrs = (system: oracle.DbSystem, project: string) => {
  const name = system.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    dbSystemId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: system.displayName,
    odbNetwork: system.odbNetwork,
    odbSubnet: system.odbSubnet,
    gcpOracleZone: system.gcpOracleZone,
    labels: userLabels(system.labels),
    entitlementId: system.entitlementId,
    lifecycleState: system.properties?.lifecycleState,
    shape: system.properties?.shape,
    hostname: system.properties?.hostname,
    ocid: system.properties?.ocid,
    createTime: system.createTime,
  };
};

const getByName = (name: string) =>
  retryQuota(oracle.getProjectsLocationsDbSystems({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listSystems = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      oracle.listProjectsLocationsDbSystems.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.dbSystems,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
    );
  return listAtLocation(project, region, collect).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );
};

export const DbSystemProvider = () =>
  Provider.succeed(DbSystem, {
    stables: [
      "name",
      "dbSystemId",
      "project",
      "location",
      "createTime",
      "ocid",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousOdb = olds?.odbSubnet ?? output?.odbSubnet ?? "";
      const nextOdb = news.odbSubnet ?? previousOdb;
      const previousShape =
        olds?.shape ?? olds?.properties?.shape ?? output?.shape ?? "";
      const nextShape = news.shape ?? news.properties?.shape ?? previousShape;
      return replaceOnIdentity({
        previousId: olds?.dbSystemId ?? output?.dbSystemId,
        nextId: news.dbSystemId ?? olds?.dbSystemId ?? output?.dbSystemId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra: nextOdb !== previousOdb || nextShape !== previousShape,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dbSystemId = yield* toPhysicalId(
        id,
        olds?.dbSystemId,
        output?.dbSystemId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceNameOf(env.project, location, COLLECTION, dbSystemId);
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
        const items = yield* listSystems(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const dbSystemId = yield* toPhysicalId(
        id,
        news.dbSystemId,
        output?.dbSystemId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceNameOf(
        env.project,
        location,
        COLLECTION,
        dbSystemId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* oracle
          .createProjectsLocationsDbSystems({
            parent: parentOf(env.project, location),
            dbSystemId,
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
        (value) => value.properties?.lifecycleState,
      );

      return toAttrs(ready, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* oracle
        .deleteProjectsLocationsDbSystems({
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
