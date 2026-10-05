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
  fieldMask,
  fingerprint,
  hasAlchemyLabelMap,
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

export type ConnectionProfileProvider =
  | dm.ConnectionProfileProviderEnum
  | (string & {});
export type ConnectionProfileState =
  | dm.ConnectionProfileStateEnum
  | (string & {});
export type ConnectionProfileRole =
  | dm.ConnectionProfileRoleEnum
  | (string & {});
export type MySqlConnectionProfile = dm.MySqlConnectionProfile;
export type PostgreSqlConnectionProfile = dm.PostgreSqlConnectionProfile;
export type OracleConnectionProfile = dm.OracleConnectionProfile;
export type SqlServerConnectionProfile = dm.SqlServerConnectionProfile;
export type CloudSqlConnectionProfile = dm.CloudSqlConnectionProfile;
export type CloudSqlSettings = dm.CloudSqlSettings;
export type AlloyDbConnectionProfile = dm.AlloyDbConnectionProfile;
export type AlloyDbSettings = dm.AlloyDbSettings;
export type SslConfig = dm.SslConfig;
export type Status = dm.Status;

export type ConnectionProfileProps = {
  /**
   * Connection profile id (the `{connectionProfile}` segment of
   * `projects/{project}/locations/{location}/connectionProfiles/{connectionProfile}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing it
   * replaces the profile.
   */
  connectionProfileId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * profile. `US-CENTRAL1` is accepted and normalized to `us-central1`.
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
   * Database provider (`CLOUDSQL`, `RDS`, `AURORA`, `ALLOYDB`,
   * `AZURE_DATABASE`).
   */
  provider?: ConnectionProfileProvider;
  /**
   * Connection profile role (`SOURCE` or `DESTINATION`).
   */
  role?: ConnectionProfileRole;
  /**
   * MySQL source/destination connection. Mutually exclusive with the other
   * engine blocks. Switching engines replaces the profile.
   */
  mysql?: MySqlConnectionProfile;
  /**
   * PostgreSQL source/destination connection. Mutually exclusive with the
   * other engine blocks. Switching engines replaces the profile.
   */
  postgresql?: PostgreSqlConnectionProfile;
  /**
   * Oracle source connection. Mutually exclusive with the other engine
   * blocks. Switching engines replaces the profile.
   */
  oracle?: OracleConnectionProfile;
  /**
   * SQL Server source connection. Mutually exclusive with the other engine
   * blocks. Switching engines replaces the profile.
   */
  sqlserver?: SqlServerConnectionProfile;
  /**
   * Cloud SQL destination. `settings` are immutable after create —
   * changing them replaces the profile. Creating this engine provisions a
   * Cloud SQL replica. Delete always force-deletes that replica.
   */
  cloudsql?: CloudSqlConnectionProfile;
  /**
   * AlloyDB destination. `clusterId` and `settings` are immutable —
   * changing them replaces the profile.
   */
  alloydb?: AlloyDbConnectionProfile;
  /**
   * Oracle only: create without validating connectivity.
   */
  skipValidation?: boolean;
  /**
   * Oracle only: validate without creating resources.
   */
  validateOnly?: boolean;
};

export type ConnectionProfile = Resource<
  "GCP.DataMigration.ConnectionProfile",
  ConnectionProfileProps,
  {
    /** Full resource name. */
    name: string;
    /** Connection profile id (last path segment). */
    connectionProfileId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Database provider. */
    provider: string | undefined;
    /** Source or destination role. */
    role: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** MySQL connection (password omitted). */
    mysql: MySqlConnectionProfile | undefined;
    /** PostgreSQL connection (password omitted). */
    postgresql: PostgreSqlConnectionProfile | undefined;
    /** Oracle connection (password omitted). */
    oracle: OracleConnectionProfile | undefined;
    /** SQL Server connection (password omitted). */
    sqlserver: SqlServerConnectionProfile | undefined;
    /** Cloud SQL destination (root password omitted). */
    cloudsql: CloudSqlConnectionProfile | undefined;
    /** AlloyDB destination (initial user password omitted). */
    alloydb: AlloyDbConnectionProfile | undefined;
    /** Failure details when `state` is `FAILED`. */
    error: Status | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Database Migration Service connection profile: credentials and
 * connectivity for a source database, or settings used to provision a
 * Cloud SQL / AlloyDB destination.
 *
 * `connectionProfileId`, `location`, and the engine kind
 * (`mysql` / `postgresql` / `oracle` / `sqlserver` / `cloudsql` /
 * `alloydb`) plus immutable Cloud SQL / AlloyDB settings are replacement
 * triggers. Display name, labels, role, provider, and credential fields
 * update in place. Passwords are input-only and never returned.
 *
 * ### Creating a Connection Profile
 * **Example:** MySQL source
 * ```typescript
 * const source = yield* GCP.DataMigration.ConnectionProfile("MysqlSrc", {
 *   mysql: {
 *     host: "10.0.0.8",
 *     port: 3306,
 *     username: "dms",
 *     password: process.env.MYSQL_PASSWORD,
 *   },
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Cloud SQL destination
 * ```typescript
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
 * ```
 *
 * @resource
 * @category DataMigration
 */
export const ConnectionProfile = Resource<ConnectionProfile>(
  "GCP.DataMigration.ConnectionProfile",
);

const resourceName = (
  project: string,
  location: string,
  connectionProfileId: string,
) =>
  `${locationParent(project, location)}/connectionProfiles/${connectionProfileId}`;

const kindOf = (value: {
  mysql?: unknown;
  postgresql?: unknown;
  oracle?: unknown;
  sqlserver?: unknown;
  cloudsql?: unknown;
  alloydb?: unknown;
}) =>
  value.mysql
    ? "mysql"
    : value.postgresql
      ? "postgresql"
      : value.oracle
        ? "oracle"
        : value.sqlserver
          ? "sqlserver"
          : value.cloudsql
            ? "cloudsql"
            : value.alloydb
              ? "alloydb"
              : "";

const publicSsl = (ssl: SslConfig | undefined) =>
  ssl === undefined
    ? undefined
    : {
        type: ssl.type,
        sslFlags: ssl.sslFlags,
      };

const publicMysql = (mysql: MySqlConnectionProfile | undefined) =>
  mysql === undefined
    ? undefined
    : {
        host: mysql.host,
        port: mysql.port,
        username: mysql.username,
        cloudSqlId: mysql.cloudSqlId,
        passwordSet: mysql.passwordSet,
        ssl: publicSsl(mysql.ssl),
      };

const publicPostgresql = (
  postgresql: PostgreSqlConnectionProfile | undefined,
) =>
  postgresql === undefined
    ? undefined
    : {
        host: postgresql.host,
        port: postgresql.port,
        username: postgresql.username,
        database: postgresql.database,
        cloudSqlId: postgresql.cloudSqlId,
        alloydbClusterId: postgresql.alloydbClusterId,
        enableIamAuthentication: postgresql.enableIamAuthentication,
        privateConnectivity: postgresql.privateConnectivity,
        privateServiceConnectConnectivity:
          postgresql.privateServiceConnectConnectivity,
        forwardSshConnectivity: postgresql.forwardSshConnectivity
          ? {
              hostname: postgresql.forwardSshConnectivity.hostname,
              port: postgresql.forwardSshConnectivity.port,
              username: postgresql.forwardSshConnectivity.username,
            }
          : undefined,
        passwordSet: postgresql.passwordSet,
        ssl: publicSsl(postgresql.ssl),
      };

const publicOracle = (oracle: OracleConnectionProfile | undefined) =>
  oracle === undefined
    ? undefined
    : {
        host: oracle.host,
        port: oracle.port,
        username: oracle.username,
        databaseService: oracle.databaseService,
        privateConnectivity: oracle.privateConnectivity,
        forwardSshConnectivity: oracle.forwardSshConnectivity
          ? {
              hostname: oracle.forwardSshConnectivity.hostname,
              port: oracle.forwardSshConnectivity.port,
              username: oracle.forwardSshConnectivity.username,
            }
          : undefined,
        oracleAsmConfig: oracle.oracleAsmConfig
          ? {
              hostname: oracle.oracleAsmConfig.hostname,
              port: oracle.oracleAsmConfig.port,
              asmService: oracle.oracleAsmConfig.asmService,
              username: oracle.oracleAsmConfig.username,
              ssl: publicSsl(oracle.oracleAsmConfig.ssl),
            }
          : undefined,
        passwordSet: oracle.passwordSet,
        ssl: publicSsl(oracle.ssl),
      };

const publicSqlserver = (sqlserver: SqlServerConnectionProfile | undefined) =>
  sqlserver === undefined
    ? undefined
    : {
        host: sqlserver.host,
        port: sqlserver.port,
        username: sqlserver.username,
        database: sqlserver.database,
        cloudSqlId: sqlserver.cloudSqlId,
        cloudSqlProjectId: sqlserver.cloudSqlProjectId,
        dbmPort: sqlserver.dbmPort,
        backups: sqlserver.backups,
        privateConnectivity: sqlserver.privateConnectivity,
        privateServiceConnectConnectivity:
          sqlserver.privateServiceConnectConnectivity,
        passwordSet: sqlserver.passwordSet,
        ssl: publicSsl(sqlserver.ssl),
      };

const publicCloudsql = (cloudsql: CloudSqlConnectionProfile | undefined) =>
  cloudsql === undefined
    ? undefined
    : {
        cloudSqlId: cloudsql.cloudSqlId,
        publicIp: cloudsql.publicIp,
        privateIp: cloudsql.privateIp,
        additionalPublicIp: cloudsql.additionalPublicIp,
        settings: cloudsql.settings
          ? {
              ...cloudsql.settings,
              rootPassword: undefined,
            }
          : undefined,
      };

const publicAlloydb = (alloydb: AlloyDbConnectionProfile | undefined) =>
  alloydb === undefined
    ? undefined
    : {
        clusterId: alloydb.clusterId,
        settings: alloydb.settings
          ? {
              ...alloydb.settings,
              initialUser: alloydb.settings.initialUser
                ? {
                    user: alloydb.settings.initialUser.user,
                    passwordSet: alloydb.settings.initialUser.passwordSet,
                  }
                : undefined,
            }
          : undefined,
      };

const toAttrs = (profile: dm.ConnectionProfile, project: string) => {
  const name = profile.name ?? "";
  const parsed = parseName(name, "connectionProfiles");
  return {
    name,
    connectionProfileId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: profile.displayName,
    labels: userLabels(profile.labels),
    provider: profile.provider,
    role: profile.role,
    state: profile.state,
    mysql: publicMysql(profile.mysql),
    postgresql: publicPostgresql(profile.postgresql),
    oracle: publicOracle(profile.oracle),
    sqlserver: publicSqlserver(profile.sqlserver),
    cloudsql: publicCloudsql(profile.cloudsql),
    alloydb: publicAlloydb(profile.alloydb),
    error: profile.error,
    createTime: profile.createTime,
    updateTime: profile.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dm
        .getProjectsLocationsConnectionProfiles({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  dm.listProjectsLocationsConnectionProfiles
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.connectionProfiles ?? []),
      ),
      Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        dm.listProjectsLocationsConnectionProfiles
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.connectionProfiles ?? []),
            ),
            Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as dm.ConnectionProfile[]),
            ),
          ),
      ),
    );

const secretChanged = (
  newsHasSecret: boolean,
  publicPrevious: unknown,
  publicNext: unknown,
) => newsHasSecret || fingerprint(publicPrevious) !== fingerprint(publicNext);

export const ConnectionProfileProvider = () =>
  Provider.succeed(ConnectionProfile, {
    stables: [
      "name",
      "connectionProfileId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousKind = kindOf({
        mysql: olds?.mysql ?? output?.mysql,
        postgresql: olds?.postgresql ?? output?.postgresql,
        oracle: olds?.oracle ?? output?.oracle,
        sqlserver: olds?.sqlserver ?? output?.sqlserver,
        cloudsql: olds?.cloudsql ?? output?.cloudsql,
        alloydb: olds?.alloydb ?? output?.alloydb,
      });
      const nextKind = kindOf(news) || previousKind;
      const previousCloudsql = fingerprint(
        publicCloudsql(olds?.cloudsql ?? output?.cloudsql)?.settings,
      );
      const nextCloudsql = fingerprint(publicCloudsql(news.cloudsql)?.settings);
      const previousAlloy = fingerprint({
        clusterId: olds?.alloydb?.clusterId ?? output?.alloydb?.clusterId,
        settings: publicAlloydb(olds?.alloydb ?? output?.alloydb)?.settings,
      });
      const nextAlloy = fingerprint({
        clusterId: news.alloydb?.clusterId,
        settings: publicAlloydb(news.alloydb)?.settings,
      });
      return replaceOnIdentity({
        previousId: olds?.connectionProfileId ?? output?.connectionProfileId,
        nextId:
          news.connectionProfileId ??
          olds?.connectionProfileId ??
          output?.connectionProfileId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          previousKind !== nextKind ||
          (nextKind === "cloudsql" &&
            news.cloudsql !== undefined &&
            previousCloudsql !== nextCloudsql) ||
          (nextKind === "alloydb" &&
            news.alloydb !== undefined &&
            previousAlloy !== nextAlloy),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const connectionProfileId = yield* toPhysicalId(
        id,
        olds?.connectionProfileId,
        output?.connectionProfileId,
        "profile",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, connectionProfileId);
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
      const connectionProfileId = yield* toPhysicalId(
        id,
        news.connectionProfileId,
        output?.connectionProfileId,
        "profile",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, connectionProfileId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? connectionProfileId;
      const body: dm.ConnectionProfile = {
        displayName,
        labels: desiredLabels,
        provider: news.provider,
        role: news.role,
        mysql: news.mysql,
        postgresql: news.postgresql,
        oracle: news.oracle,
        sqlserver: news.sqlserver,
        cloudsql: news.cloudsql,
        alloydb: news.alloydb,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dm
          .createProjectsLocationsConnectionProfiles({
            parent: locationParent(env.project, location),
            connectionProfileId,
            skipValidation: news.skipValidation,
            validateOnly: news.validateOnly,
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
      const providerChanged =
        news.provider !== undefined &&
        (current.provider ?? "") !== news.provider;
      const roleChanged =
        news.role !== undefined && (current.role ?? "") !== news.role;
      const mysqlChanged =
        news.mysql !== undefined &&
        secretChanged(
          news.mysql.password !== undefined ||
            news.mysql.ssl?.caCertificate !== undefined ||
            news.mysql.ssl?.clientCertificate !== undefined ||
            news.mysql.ssl?.clientKey !== undefined,
          publicMysql(current.mysql),
          publicMysql(news.mysql),
        );
      const postgresqlChanged =
        news.postgresql !== undefined &&
        secretChanged(
          news.postgresql.password !== undefined ||
            news.postgresql.ssl?.caCertificate !== undefined ||
            news.postgresql.ssl?.clientCertificate !== undefined ||
            news.postgresql.ssl?.clientKey !== undefined ||
            news.postgresql.forwardSshConnectivity?.password !== undefined ||
            news.postgresql.forwardSshConnectivity?.privateKey !== undefined,
          publicPostgresql(current.postgresql),
          publicPostgresql(news.postgresql),
        );
      const oracleChanged =
        news.oracle !== undefined &&
        secretChanged(
          news.oracle.password !== undefined ||
            news.oracle.ssl?.caCertificate !== undefined ||
            news.oracle.oracleAsmConfig?.password !== undefined,
          publicOracle(current.oracle),
          publicOracle(news.oracle),
        );
      const sqlserverChanged =
        news.sqlserver !== undefined &&
        secretChanged(
          news.sqlserver.password !== undefined ||
            news.sqlserver.ssl?.caCertificate !== undefined,
          publicSqlserver(current.sqlserver),
          publicSqlserver(news.sqlserver),
        );
      const mask = fieldMask([
        labelsChanged && "labels",
        displayNameChanged && "displayName",
        providerChanged && "provider",
        roleChanged && "role",
        mysqlChanged && "mysql",
        postgresqlChanged && "postgresql",
        oracleChanged && "oracle",
        sqlserverChanged && "sqlserver",
      ]);

      if (mask.length > 0) {
        const operation = yield* dm.patchProjectsLocationsConnectionProfiles({
          name: current.name ?? name,
          updateMask: mask,
          skipValidation: news.skipValidation,
          validateOnly: news.validateOnly,
          body: {
            name: current.name ?? name,
            displayName,
            labels: desiredLabels,
            provider: news.provider,
            role: news.role,
            mysql: news.mysql,
            postgresql: news.postgresql,
            oracle: news.oracle,
            sqlserver: news.sqlserver,
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
        .deleteProjectsLocationsConnectionProfiles({
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
