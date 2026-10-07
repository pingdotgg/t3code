import * as dm from "@distilled.cloud/gcp/datamigration_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  connectionProfileOf,
  fieldMask,
  fingerprint,
  hasAlchemyLabelMap,
  lastSegment,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type MigrationJobType = dm.MigrationJobTypeEnum | (string & {});
export type MigrationJobState = dm.MigrationJobStateEnum | (string & {});
export type MigrationJobPhase = dm.MigrationJobPhaseEnum | (string & {});
export type MigrationJobPurpose = dm.MigrationJobPurposeEnum | (string & {});
export type MigrationJobDumpType = dm.MigrationJobDumpTypeEnum | (string & {});
export type DatabaseType = dm.DatabaseType;
export type DumpFlags = dm.DumpFlags;
export type ConversionWorkspaceInfo = dm.ConversionWorkspaceInfo;
export type VpcPeeringConnectivity = dm.VpcPeeringConnectivity;
export type ReverseSshConnectivity = dm.ReverseSshConnectivity;
export type PerformanceConfig = dm.PerformanceConfig;
export type MigrationJobObjectsConfig = dm.MigrationJobObjectsConfig;
export type SqlServerToPostgresConfig = dm.SqlServerToPostgresConfig;
export type OracleToPostgresConfig = dm.OracleToPostgresConfig;
export type PostgresToSqlServerConfig = dm.PostgresToSqlServerConfig;
export type MySqlHomogeneousConfig = dm.MySqlHomogeneousConfig;
export type PostgresHomogeneousConfig = dm.PostgresHomogeneousConfig;
export type SqlServerHomogeneousMigrationJobConfig =
  dm.SqlServerHomogeneousMigrationJobConfig;
type Status = dm.Status;

export type MigrationJobProps = {
  /**
   * Migration job id (the `{migrationJob}` segment of
   * `projects/{project}/locations/{location}/migrationJobs/{migrationJob}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the job.
   */
  migrationJobId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the job.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Migration type (`ONE_TIME` or `CONTINUOUS`). Immutable — changing it
   * replaces the job.
   */
  type: MigrationJobType;
  /**
   * Source connection profile. Full name or id (combined with
   * `location`). Immutable — changing it replaces the job.
   */
  source: string;
  /**
   * Destination connection profile. Full name or id (combined with
   * `location`). Immutable — changing it replaces the job.
   */
  destination: string;
  /**
   * Source database engine/provider metadata.
   */
  sourceDatabase?: DatabaseType;
  /**
   * Destination database engine/provider metadata.
   */
  destinationDatabase?: DatabaseType;
  /**
   * Conversion workspace used by heterogeneous migrations.
   */
  conversionWorkspace?: ConversionWorkspaceInfo;
  /**
   * Static IP connectivity (default). Mutually exclusive with VPC peering
   * and reverse SSH.
   */
  staticIpConnectivity?: Record<string, never>;
  /**
   * VPC peering connectivity to the source.
   */
  vpcPeeringConnectivity?: VpcPeeringConnectivity;
  /**
   * Reverse SSH tunnel connectivity to the source.
   */
  reverseSshConnectivity?: ReverseSshConnectivity;
  /**
   * Initial dump flags. Mutually exclusive with `dumpPath`.
   */
  dumpFlags?: DumpFlags;
  /**
   * GCS dump path (`gs://bucket/object`). Mutually exclusive with
   * `dumpFlags`.
   */
  dumpPath?: string;
  /**
   * Dump type for MySQL to Cloud SQL for MySQL.
   */
  dumpType?: MigrationJobDumpType;
  /**
   * Dump parallelism settings.
   */
  performanceConfig?: PerformanceConfig;
  /**
   * AIP-160 entity filter when a conversion workspace is attached.
   */
  filter?: string;
  /**
   * Objects that need to be migrated.
   */
  objectsConfig?: MigrationJobObjectsConfig;
  /**
   * CMEK used for the job. Immutable — changing it replaces the job.
   */
  cmekKeyName?: string;
  /**
   * Failback pointer to the original migration job.
   */
  originalMigrationName?: string;
  /**
   * Heterogeneous SQL Server to PostgreSQL config.
   */
  sqlserverToPostgresConfig?: SqlServerToPostgresConfig;
  /**
   * Heterogeneous Oracle to PostgreSQL config.
   */
  oracleToPostgresConfig?: OracleToPostgresConfig;
  /**
   * Heterogeneous PostgreSQL to SQL Server config.
   */
  postgresToSqlserverConfig?: PostgresToSqlServerConfig;
  /**
   * Homogeneous MySQL config.
   */
  mysqlHomogeneousConfig?: MySqlHomogeneousConfig;
  /**
   * Homogeneous PostgreSQL config.
   */
  postgresHomogeneousConfig?: PostgresHomogeneousConfig;
  /**
   * Homogeneous SQL Server config.
   */
  sqlserverHomogeneousMigrationJobConfig?: SqlServerHomogeneousMigrationJobConfig;
};

export type MigrationJob = Resource<
  "GCP.DataMigration.MigrationJob",
  MigrationJobProps,
  {
    /** Full resource name. */
    name: string;
    /** Migration job id (last path segment). */
    migrationJobId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Migration type. */
    type: string | undefined;
    /** Source connection profile name. */
    source: string | undefined;
    /** Destination connection profile name. */
    destination: string | undefined;
    /** Source database metadata. */
    sourceDatabase: DatabaseType | undefined;
    /** Destination database metadata. */
    destinationDatabase: DatabaseType | undefined;
    /** Conversion workspace info. */
    conversionWorkspace: ConversionWorkspaceInfo | undefined;
    /** Static IP connectivity. */
    staticIpConnectivity: Record<string, never> | undefined;
    /** VPC peering connectivity. */
    vpcPeeringConnectivity: VpcPeeringConnectivity | undefined;
    /** Reverse SSH connectivity. */
    reverseSshConnectivity: ReverseSshConnectivity | undefined;
    /** Dump flags. */
    dumpFlags: DumpFlags | undefined;
    /** GCS dump path. */
    dumpPath: string | undefined;
    /** Dump type. */
    dumpType: string | undefined;
    /** Dump parallelism. */
    performanceConfig: PerformanceConfig | undefined;
    /** Entity filter. */
    filter: string | undefined;
    /** Objects config. */
    objectsConfig: MigrationJobObjectsConfig | undefined;
    /** CMEK name. */
    cmekKeyName: string | undefined;
    /** Original migration job for failback. */
    originalMigrationName: string | undefined;
    /** SQL Server to PostgreSQL config. */
    sqlserverToPostgresConfig: SqlServerToPostgresConfig | undefined;
    /** Oracle to PostgreSQL config. */
    oracleToPostgresConfig: OracleToPostgresConfig | undefined;
    /** PostgreSQL to SQL Server config. */
    postgresToSqlserverConfig: PostgresToSqlServerConfig | undefined;
    /** Homogeneous MySQL config. */
    mysqlHomogeneousConfig: MySqlHomogeneousConfig | undefined;
    /** Homogeneous PostgreSQL config. */
    postgresHomogeneousConfig: PostgresHomogeneousConfig | undefined;
    /** Homogeneous SQL Server config. */
    sqlserverHomogeneousMigrationJobConfig:
      | SqlServerHomogeneousMigrationJobConfig
      | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Current phase. */
    phase: string | undefined;
    /** Forward or failback purpose. */
    purpose: string | undefined;
    /** Duration of the job. */
    duration: string | undefined;
    /** Failure details when `state` is `FAILED`. */
    error: Status | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 completion timestamp. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Database Migration Service migration job: copies data from a source
 * connection profile to a destination (Cloud SQL or AlloyDB).
 *
 * `migrationJobId`, `location`, `type`, `source`, `destination`, and
 * `cmekKeyName` are replacement triggers. Display name, labels, dump
 * flags, connectivity, and performance config update in place. Delete
 * force-deletes the destination Cloud SQL replica.
 *
 * ### Creating a Migration Job
 * **Example:** Continuous MySQL to Cloud SQL
 * ```typescript
 * const source = yield* GCP.DataMigration.ConnectionProfile("MysqlSrc", {
 *   mysql: {
 *     host: "10.0.0.8",
 *     port: 3306,
 *     username: "dms",
 *     password: process.env.MYSQL_PASSWORD,
 *   },
 * });
 * const dest = yield* GCP.DataMigration.ConnectionProfile("MysqlDest", {
 *   cloudsql: {
 *     settings: {
 *       sourceId: source.name,
 *       databaseVersion: "MYSQL_8_0",
 *       tier: "db-n1-standard-1",
 *       rootPassword: process.env.MYSQL_ROOT_PASSWORD,
 *     },
 *   },
 * });
 * const job = yield* GCP.DataMigration.MigrationJob("Replica", {
 *   type: "CONTINUOUS",
 *   source: source.name,
 *   destination: dest.name,
 *   staticIpConnectivity: {},
 * });
 * ```
 *
 * @resource
 * @category DataMigration
 */
export const MigrationJob = Resource<MigrationJob>(
  "GCP.DataMigration.MigrationJob",
);

const resourceName = (
  project: string,
  location: string,
  migrationJobId: string,
) => `${locationParent(project, location)}/migrationJobs/${migrationJobId}`;

const emptyConnectivity = (value: unknown) =>
  value === undefined ? undefined : {};

const publicReverseSsh = (value: ReverseSshConnectivity | undefined) =>
  value === undefined
    ? undefined
    : {
        vmIp: value.vmIp,
        vmPort: value.vmPort,
        vpc: value.vpc,
      };

const toAttrs = (job: dm.MigrationJob, project: string) => {
  const name = job.name ?? "";
  const parsed = parseName(name, "migrationJobs");
  return {
    name,
    migrationJobId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: job.displayName,
    labels: userLabels(job.labels),
    type: job.type,
    source: job.source,
    destination: job.destination,
    sourceDatabase: job.sourceDatabase,
    destinationDatabase: job.destinationDatabase,
    conversionWorkspace: job.conversionWorkspace,
    staticIpConnectivity: emptyConnectivity(job.staticIpConnectivity),
    vpcPeeringConnectivity: job.vpcPeeringConnectivity,
    reverseSshConnectivity: publicReverseSsh(job.reverseSshConnectivity),
    dumpFlags: job.dumpFlags,
    dumpPath: job.dumpPath,
    dumpType: job.dumpType,
    performanceConfig: job.performanceConfig,
    filter: job.filter,
    objectsConfig: job.objectsConfig,
    cmekKeyName: job.cmekKeyName,
    originalMigrationName: job.originalMigrationName,
    sqlserverToPostgresConfig: job.sqlserverToPostgresConfig,
    oracleToPostgresConfig: job.oracleToPostgresConfig,
    postgresToSqlserverConfig: job.postgresToSqlserverConfig,
    mysqlHomogeneousConfig: job.mysqlHomogeneousConfig,
    postgresHomogeneousConfig: job.postgresHomogeneousConfig,
    sqlserverHomogeneousMigrationJobConfig:
      job.sqlserverHomogeneousMigrationJobConfig,
    state: job.state,
    phase: job.phase,
    purpose: job.purpose,
    duration: job.duration,
    error: job.error,
    createTime: job.createTime,
    updateTime: job.updateTime,
    endTime: job.endTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dm
        .getProjectsLocationsMigrationJobs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  dm.listProjectsLocationsMigrationJobs
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.migrationJobs ?? [])),
      Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        dm.listProjectsLocationsMigrationJobs
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.migrationJobs ?? []),
            ),
            Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as dm.MigrationJob[]),
            ),
          ),
      ),
    );

const connectivityKind = (value: {
  staticIpConnectivity?: unknown;
  vpcPeeringConnectivity?: unknown;
  reverseSshConnectivity?: unknown;
}) =>
  value.vpcPeeringConnectivity
    ? "vpc"
    : value.reverseSshConnectivity
      ? "ssh"
      : value.staticIpConnectivity !== undefined
        ? "static"
        : "";

export const MigrationJobProvider = () =>
  Provider.succeed(MigrationJob, {
    stables: ["name", "migrationJobId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = olds?.type ?? output?.type;
      const nextType = news.type ?? previousType;
      const previousCmek = olds?.cmekKeyName ?? output?.cmekKeyName;
      const nextCmek = news.cmekKeyName ?? previousCmek;
      const previousSource = lastSegment(olds?.source ?? output?.source ?? "");
      const nextSource = lastSegment(news.source);
      const previousDestination = lastSegment(
        olds?.destination ?? output?.destination ?? "",
      );
      const nextDestination = lastSegment(news.destination);
      return replaceOnIdentity({
        previousId: olds?.migrationJobId ?? output?.migrationJobId,
        nextId:
          news.migrationJobId ?? olds?.migrationJobId ?? output?.migrationJobId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          previousType !== nextType ||
          previousCmek !== nextCmek ||
          (previousSource.length > 0 &&
            nextSource.length > 0 &&
            previousSource !== nextSource) ||
          (previousDestination.length > 0 &&
            nextDestination.length > 0 &&
            previousDestination !== nextDestination),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const migrationJobId = yield* toPhysicalId(
        id,
        olds?.migrationJobId,
        output?.migrationJobId,
        "job",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, migrationJobId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const migrationJobId = yield* toPhysicalId(
        id,
        news.migrationJobId,
        output?.migrationJobId,
        "job",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, migrationJobId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? migrationJobId;
      const source = connectionProfileOf(news.source, env.project, location);
      const destination = connectionProfileOf(
        news.destination,
        env.project,
        location,
      );
      const staticIpConnectivity =
        news.staticIpConnectivity !== undefined ||
        (news.vpcPeeringConnectivity === undefined &&
          news.reverseSshConnectivity === undefined)
          ? {}
          : undefined;
      const body: dm.MigrationJob = {
        displayName,
        labels: desiredLabels,
        type: news.type,
        source,
        destination,
        sourceDatabase: news.sourceDatabase,
        destinationDatabase: news.destinationDatabase,
        conversionWorkspace: news.conversionWorkspace,
        staticIpConnectivity,
        vpcPeeringConnectivity: news.vpcPeeringConnectivity,
        reverseSshConnectivity: news.reverseSshConnectivity,
        dumpFlags: news.dumpFlags,
        dumpPath: news.dumpPath,
        dumpType: news.dumpType,
        performanceConfig: news.performanceConfig,
        filter: news.filter,
        objectsConfig: news.objectsConfig,
        cmekKeyName: news.cmekKeyName,
        originalMigrationName: news.originalMigrationName,
        sqlserverToPostgresConfig: news.sqlserverToPostgresConfig,
        oracleToPostgresConfig: news.oracleToPostgresConfig,
        postgresToSqlserverConfig: news.postgresToSqlserverConfig,
        mysqlHomogeneousConfig: news.mysqlHomogeneousConfig,
        postgresHomogeneousConfig: news.postgresHomogeneousConfig,
        sqlserverHomogeneousMigrationJobConfig:
          news.sqlserverHomogeneousMigrationJobConfig,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dm
          .createProjectsLocationsMigrationJobs({
            parent: locationParent(env.project, location),
            migrationJobId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const dumpFlagsChanged =
        fingerprint(current.dumpFlags) !== fingerprint(news.dumpFlags);
      const dumpPathChanged =
        (current.dumpPath ?? "") !== (news.dumpPath ?? "");
      const dumpTypeChanged =
        news.dumpType !== undefined &&
        (current.dumpType ?? "") !== news.dumpType;
      const performanceChanged =
        fingerprint(current.performanceConfig) !==
        fingerprint(news.performanceConfig);
      const filterChanged = (current.filter ?? "") !== (news.filter ?? "");
      const objectsChanged =
        fingerprint(current.objectsConfig) !== fingerprint(news.objectsConfig);
      const conversionChanged =
        fingerprint(current.conversionWorkspace) !==
        fingerprint(news.conversionWorkspace);
      const vpcChanged =
        fingerprint(current.vpcPeeringConnectivity) !==
        fingerprint(news.vpcPeeringConnectivity);
      const sshChanged =
        fingerprint(publicReverseSsh(current.reverseSshConnectivity)) !==
        fingerprint(publicReverseSsh(news.reverseSshConnectivity));
      const nextKind = connectivityKind({
        staticIpConnectivity,
        vpcPeeringConnectivity: news.vpcPeeringConnectivity,
        reverseSshConnectivity: news.reverseSshConnectivity,
      });
      const previousKind = connectivityKind(current);
      const staticChanged = nextKind === "static" && previousKind !== "static";
      const homogeneousChanged =
        fingerprint(current.mysqlHomogeneousConfig) !==
          fingerprint(news.mysqlHomogeneousConfig) ||
        fingerprint(current.postgresHomogeneousConfig) !==
          fingerprint(news.postgresHomogeneousConfig) ||
        fingerprint(current.sqlserverHomogeneousMigrationJobConfig) !==
          fingerprint(news.sqlserverHomogeneousMigrationJobConfig) ||
        fingerprint(current.sqlserverToPostgresConfig) !==
          fingerprint(news.sqlserverToPostgresConfig) ||
        fingerprint(current.oracleToPostgresConfig) !==
          fingerprint(news.oracleToPostgresConfig) ||
        fingerprint(current.postgresToSqlserverConfig) !==
          fingerprint(news.postgresToSqlserverConfig);
      const mask = fieldMask([
        labelsChanged && "labels",
        displayNameChanged && "displayName",
        dumpFlagsChanged && "dumpFlags",
        dumpPathChanged && "dumpPath",
        dumpTypeChanged && "dumpType",
        performanceChanged && "performanceConfig",
        filterChanged && "filter",
        objectsChanged && "objectsConfig",
        conversionChanged && "conversionWorkspace",
        vpcChanged && "vpcPeeringConnectivity",
        sshChanged && "reverseSshConnectivity",
        staticChanged && "staticIpConnectivity",
        homogeneousChanged && "mysqlHomogeneousConfig",
        homogeneousChanged && "postgresHomogeneousConfig",
        homogeneousChanged && "sqlserverHomogeneousMigrationJobConfig",
        homogeneousChanged && "sqlserverToPostgresConfig",
        homogeneousChanged && "oracleToPostgresConfig",
        homogeneousChanged && "postgresToSqlserverConfig",
      ]);

      if (mask.length > 0) {
        const operation = yield* dm.patchProjectsLocationsMigrationJobs({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            ...body,
            name: current.name ?? name,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* dm
        .deleteProjectsLocationsMigrationJobs({
          name: output.name,
          force: true,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
