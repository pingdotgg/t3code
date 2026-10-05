import * as ds from "@distilled.cloud/gcp/datastream_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  collectPages,
  emptyMessage,
  fieldMask,
  fingerprint,
  hasAlchemyLabelMap,
  listAtLocation,
  locationParent,
  normalizeLocation,
  parseName,
  privateConnectionOf,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  settleOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type MysqlProfile = ds.MysqlProfile;
export type PostgresqlProfile = ds.PostgresqlProfile;
export type OracleProfile = ds.OracleProfile;
export type SqlServerProfile = ds.SqlServerProfile;
export type MongodbProfile = ds.MongodbProfile;
export type SpannerProfile = ds.SpannerProfile;
export type GcsProfile = ds.GcsProfile;
export type BigQueryProfile = ds.BigQueryProfile;
export type SalesforceProfile = ds.SalesforceProfile;
export type SalesforceMarketingCloudProfile =
  ds.SalesforceMarketingCloudProfile;
export type ServiceNowProfile = ds.ServiceNowProfile;
export type DataverseProfile = ds.DataverseProfile;
export type ForwardSshTunnelConnectivity = ds.ForwardSshTunnelConnectivity;
export type PrivateConnectivity = ds.PrivateConnectivity;
export type MysqlSslConfig = ds.MysqlSslConfig;
export type PostgresqlSslConfig = ds.PostgresqlSslConfig;
export type OracleSslConfig = ds.OracleSslConfig;
export type SqlServerSslConfig = ds.SqlServerSslConfig;
export type MongodbSslConfig = ds.MongodbSslConfig;
export type OracleAsmConfig = ds.OracleAsmConfig;
export type Secret = ds.Secret;

export type ConnectionProfileProps = {
  /**
   * Connection profile id (the `{connectionProfile}` segment of
   * `projects/{project}/locations/{location}/connectionProfiles/{connectionProfile}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the profile.
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
   * MySQL source profile. Mutually exclusive with the other engine
   * blocks. Switching engines replaces the profile.
   */
  mysqlProfile?: MysqlProfile;
  /**
   * PostgreSQL source profile. Mutually exclusive with the other engine
   * blocks. Switching engines replaces the profile.
   */
  postgresqlProfile?: PostgresqlProfile;
  /**
   * Oracle source profile. Mutually exclusive with the other engine
   * blocks. Switching engines replaces the profile.
   */
  oracleProfile?: OracleProfile;
  /**
   * SQL Server source profile. Mutually exclusive with the other engine
   * blocks. Switching engines replaces the profile.
   */
  sqlServerProfile?: SqlServerProfile;
  /**
   * MongoDB source profile. Mutually exclusive with the other engine
   * blocks. Switching engines replaces the profile.
   */
  mongodbProfile?: MongodbProfile;
  /**
   * Spanner source profile. `database` is immutable — changing it
   * replaces the profile.
   */
  spannerProfile?: SpannerProfile;
  /**
   * Cloud Storage destination profile. Mutually exclusive with the other
   * engine blocks. Switching engines replaces the profile.
   */
  gcsProfile?: GcsProfile;
  /**
   * BigQuery destination profile (empty object). Mutually exclusive with
   * the other engine blocks. Switching engines replaces the profile.
   */
  bigqueryProfile?: BigQueryProfile;
  /**
   * Salesforce source profile. Mutually exclusive with the other engine
   * blocks. Switching engines replaces the profile.
   */
  salesforceProfile?: SalesforceProfile;
  /**
   * Salesforce Marketing Cloud source profile. Mutually exclusive with
   * the other engine blocks. Switching engines replaces the profile.
   */
  salesforceMarketingCloudProfile?: SalesforceMarketingCloudProfile;
  /**
   * ServiceNow source profile. Mutually exclusive with the other engine
   * blocks. Switching engines replaces the profile.
   */
  serviceNowProfile?: ServiceNowProfile;
  /**
   * Dataverse source profile. Mutually exclusive with the other engine
   * blocks. Switching engines replaces the profile.
   */
  dataverseProfile?: DataverseProfile;
  /**
   * Static service IP connectivity (Datastream public IPs). Mutually
   * exclusive with SSH tunnel and private connectivity.
   */
  staticServiceIpConnectivity?: Record<string, never>;
  /**
   * Forward SSH tunnel connectivity. Mutually exclusive with static IP
   * and private connectivity. Passwords and private keys are input-only.
   */
  forwardSshConnectivity?: ForwardSshTunnelConnectivity;
  /**
   * Private connectivity via a Datastream private connection. Full name
   * or id (combined with `location`). Mutually exclusive with static IP
   * and SSH tunnel.
   */
  privateConnectivity?: {
    privateConnection: string;
  };
  /**
   * Create or update without validating connectivity.
   */
  force?: boolean;
  /**
   * Validate without creating or updating resources.
   */
  validateOnly?: boolean;
};

export type ConnectionProfile = Resource<
  "GCP.Datastream.ConnectionProfile",
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
    /** MySQL profile (password omitted). */
    mysqlProfile: MysqlProfile | undefined;
    /** PostgreSQL profile (password omitted). */
    postgresqlProfile: PostgresqlProfile | undefined;
    /** Oracle profile (password omitted). */
    oracleProfile: OracleProfile | undefined;
    /** SQL Server profile (password omitted). */
    sqlServerProfile: SqlServerProfile | undefined;
    /** MongoDB profile (password omitted). */
    mongodbProfile: MongodbProfile | undefined;
    /** Spanner profile. */
    spannerProfile: SpannerProfile | undefined;
    /** Cloud Storage destination profile. */
    gcsProfile: GcsProfile | undefined;
    /** BigQuery destination profile. */
    bigqueryProfile: BigQueryProfile | undefined;
    /** Salesforce profile (secrets omitted). */
    salesforceProfile: SalesforceProfile | undefined;
    /** Salesforce Marketing Cloud profile (secrets omitted). */
    salesforceMarketingCloudProfile:
      | SalesforceMarketingCloudProfile
      | undefined;
    /** ServiceNow profile (secrets omitted). */
    serviceNowProfile: ServiceNowProfile | undefined;
    /** Dataverse profile (secrets omitted). */
    dataverseProfile: DataverseProfile | undefined;
    /** Static service IP connectivity. */
    staticServiceIpConnectivity: Record<string, never> | undefined;
    /** Forward SSH connectivity (password and key omitted). */
    forwardSshConnectivity: ForwardSshTunnelConnectivity | undefined;
    /** Private connectivity. */
    privateConnectivity: PrivateConnectivity | undefined;
    /** Whether the profile satisfies physical zone isolation. */
    satisfiesPzi: boolean | undefined;
    /** Whether the profile satisfies physical zone separation. */
    satisfiesPzs: boolean | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Datastream connection profile: credentials and connectivity for a
 * source database or a BigQuery / Cloud Storage destination.
 *
 * `connectionProfileId`, `location`, and the engine kind
 * (`mysqlProfile` / `postgresqlProfile` / `oracleProfile` /
 * `sqlServerProfile` / `mongodbProfile` / `spannerProfile` /
 * `gcsProfile` / `bigqueryProfile` / `salesforceProfile` /
 * `salesforceMarketingCloudProfile` / `serviceNowProfile` /
 * `dataverseProfile`) plus Spanner `database` are replacement triggers.
 * Display name, labels, credentials, and connectivity update in place.
 * Passwords, SSL keys, and OAuth secrets are input-only and never
 * returned.
 *
 * ### Creating a Connection Profile
 * **Example:** BigQuery destination
 * ```typescript
 * const dest = yield* GCP.Datastream.ConnectionProfile("BqDest", {
 *   bigqueryProfile: {},
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** MySQL source
 * ```typescript
 * const source = yield* GCP.Datastream.ConnectionProfile("MysqlSrc", {
 *   mysqlProfile: {
 *     hostname: "10.0.0.8",
 *     port: 3306,
 *     username: "datastream",
 *     password: process.env.MYSQL_PASSWORD,
 *   },
 *   staticServiceIpConnectivity: {},
 *   force: true,
 * });
 * ```
 *
 * **Example:** Cloud Storage destination
 * ```typescript
 * const gcs = yield* GCP.Datastream.ConnectionProfile("GcsDest", {
 *   gcsProfile: { bucket: bucket.bucketName, rootPath: "/data" },
 * });
 * ```
 *
 * @resource
 * @category Datastream
 */
export const ConnectionProfile = Resource<ConnectionProfile>(
  "GCP.Datastream.ConnectionProfile",
);

const resourceName = (
  project: string,
  location: string,
  connectionProfileId: string,
) =>
  `${locationParent(project, location)}/connectionProfiles/${connectionProfileId}`;

const kindOf = (value: {
  mysqlProfile?: unknown;
  postgresqlProfile?: unknown;
  oracleProfile?: unknown;
  sqlServerProfile?: unknown;
  mongodbProfile?: unknown;
  spannerProfile?: unknown;
  gcsProfile?: unknown;
  bigqueryProfile?: unknown;
  salesforceProfile?: unknown;
  salesforceMarketingCloudProfile?: unknown;
  serviceNowProfile?: unknown;
  dataverseProfile?: unknown;
}) =>
  value.mysqlProfile
    ? "mysql"
    : value.postgresqlProfile
      ? "postgresql"
      : value.oracleProfile
        ? "oracle"
        : value.sqlServerProfile
          ? "sqlserver"
          : value.mongodbProfile
            ? "mongodb"
            : value.spannerProfile
              ? "spanner"
              : value.gcsProfile
                ? "gcs"
                : value.bigqueryProfile
                  ? "bigquery"
                  : value.salesforceProfile
                    ? "salesforce"
                    : value.salesforceMarketingCloudProfile
                      ? "sfmc"
                      : value.serviceNowProfile
                        ? "servicenow"
                        : value.dataverseProfile
                          ? "dataverse"
                          : "";

const publicSecret = (secret: Secret | undefined) =>
  secret === undefined
    ? undefined
    : {
        secretVersion: secret.secretVersion,
      };

const publicMysqlSsl = (ssl: MysqlSslConfig | undefined) =>
  ssl === undefined
    ? undefined
    : {
        clientCertificateSet: ssl.clientCertificateSet,
        caCertificateSet: ssl.caCertificateSet,
        clientKeySet: ssl.clientKeySet,
      };

const publicPostgresSsl = (ssl: PostgresqlSslConfig | undefined) =>
  ssl === undefined
    ? undefined
    : {
        serverVerification: ssl.serverVerification
          ? {
              serverCertificateHostname:
                ssl.serverVerification.serverCertificateHostname,
            }
          : undefined,
        serverAndClientVerification: ssl.serverAndClientVerification
          ? {
              serverCertificateHostname:
                ssl.serverAndClientVerification.serverCertificateHostname,
            }
          : undefined,
      };

const publicOracleSsl = (ssl: OracleSslConfig | undefined) =>
  ssl === undefined
    ? undefined
    : {
        caCertificateSet: ssl.caCertificateSet,
        serverCertificateDistinguishedName:
          ssl.serverCertificateDistinguishedName,
      };

const publicSqlServerSsl = (ssl: SqlServerSslConfig | undefined) =>
  ssl === undefined
    ? undefined
    : {
        encryptionNotEnforced: emptyMessage(ssl.encryptionNotEnforced),
        basicEncryption: emptyMessage(ssl.basicEncryption),
        encryptionAndServerValidation: ssl.encryptionAndServerValidation
          ? {
              serverCertificateHostname:
                ssl.encryptionAndServerValidation.serverCertificateHostname,
            }
          : undefined,
      };

const publicMongodbSsl = (ssl: MongodbSslConfig | undefined) =>
  ssl === undefined
    ? undefined
    : {
        clientCertificateSet: ssl.clientCertificateSet,
        clientKeySet: ssl.clientKeySet,
        caCertificateSet: ssl.caCertificateSet,
        secretManagerStoredClientKey: ssl.secretManagerStoredClientKey,
      };

const publicMysql = (mysql: MysqlProfile | undefined) =>
  mysql === undefined
    ? undefined
    : {
        username: mysql.username,
        port: mysql.port,
        hostname: mysql.hostname,
        secretManagerStoredPassword: mysql.secretManagerStoredPassword,
        sslConfig: publicMysqlSsl(mysql.sslConfig),
      };

const publicPostgresql = (postgresql: PostgresqlProfile | undefined) =>
  postgresql === undefined
    ? undefined
    : {
        hostname: postgresql.hostname,
        database: postgresql.database,
        username: postgresql.username,
        port: postgresql.port,
        secretManagerStoredPassword: postgresql.secretManagerStoredPassword,
        sslConfig: publicPostgresSsl(postgresql.sslConfig),
      };

const publicOracleAsm = (asm: OracleAsmConfig | undefined) =>
  asm === undefined
    ? undefined
    : {
        port: asm.port,
        connectionAttributes: asm.connectionAttributes,
        username: asm.username,
        secretManagerStoredPassword: asm.secretManagerStoredPassword,
        oracleSslConfig: publicOracleSsl(asm.oracleSslConfig),
        hostname: asm.hostname,
        asmService: asm.asmService,
      };

const publicOracle = (oracle: OracleProfile | undefined) =>
  oracle === undefined
    ? undefined
    : {
        connectionAttributes: oracle.connectionAttributes,
        databaseService: oracle.databaseService,
        hostname: oracle.hostname,
        oracleSslConfig: publicOracleSsl(oracle.oracleSslConfig),
        oracleAsmConfig: publicOracleAsm(oracle.oracleAsmConfig),
        username: oracle.username,
        secretManagerStoredPassword: oracle.secretManagerStoredPassword,
        port: oracle.port,
      };

const publicSqlServer = (sqlserver: SqlServerProfile | undefined) =>
  sqlserver === undefined
    ? undefined
    : {
        hostname: sqlserver.hostname,
        sslConfig: publicSqlServerSsl(sqlserver.sslConfig),
        database: sqlserver.database,
        username: sqlserver.username,
        secretManagerStoredPassword: sqlserver.secretManagerStoredPassword,
        port: sqlserver.port,
      };

const publicMongodb = (mongodb: MongodbProfile | undefined) =>
  mongodb === undefined
    ? undefined
    : {
        hostAddresses: mongodb.hostAddresses,
        username: mongodb.username,
        secretManagerStoredPassword: mongodb.secretManagerStoredPassword,
        additionalOptions: mongodb.additionalOptions,
        replicaSet: mongodb.replicaSet,
        srvConnectionFormat: emptyMessage(mongodb.srvConnectionFormat),
        standardConnectionFormat: mongodb.standardConnectionFormat,
        sslConfig: publicMongodbSsl(mongodb.sslConfig),
      };

const publicSalesforce = (salesforce: SalesforceProfile | undefined) =>
  salesforce === undefined
    ? undefined
    : {
        domain: salesforce.domain,
        userCredentials: salesforce.userCredentials
          ? {
              username: salesforce.userCredentials.username,
              secretManagerStoredPassword:
                salesforce.userCredentials.secretManagerStoredPassword,
              secretManagerStoredSecurityToken:
                salesforce.userCredentials.secretManagerStoredSecurityToken,
            }
          : undefined,
        oauth2ClientCredentials: salesforce.oauth2ClientCredentials
          ? {
              clientId: salesforce.oauth2ClientCredentials.clientId,
              secretManagerStoredClientSecret:
                salesforce.oauth2ClientCredentials
                  .secretManagerStoredClientSecret,
            }
          : undefined,
      };

const publicSfmc = (profile: SalesforceMarketingCloudProfile | undefined) =>
  profile === undefined
    ? undefined
    : {
        subdomain: profile.subdomain,
        oauthClientCredentials: profile.oauthClientCredentials
          ? {
              clientId: profile.oauthClientCredentials.clientId,
              clientSecret: publicSecret(
                profile.oauthClientCredentials.clientSecret,
              ),
            }
          : undefined,
      };

const publicServiceNow = (profile: ServiceNowProfile | undefined) =>
  profile === undefined
    ? undefined
    : {
        instance: profile.instance,
        userPasswordCredentials: profile.userPasswordCredentials
          ? {
              username: profile.userPasswordCredentials.username,
              password: publicSecret(profile.userPasswordCredentials.password),
            }
          : undefined,
        oauthClientCredentials: profile.oauthClientCredentials
          ? {
              clientId: profile.oauthClientCredentials.clientId,
              clientSecret: publicSecret(
                profile.oauthClientCredentials.clientSecret,
              ),
            }
          : undefined,
      };

const publicDataverse = (profile: DataverseProfile | undefined) =>
  profile === undefined
    ? undefined
    : {
        tenantId: profile.tenantId,
        environmentUrl: profile.environmentUrl,
        oauthClientCredentials: profile.oauthClientCredentials
          ? {
              clientId: profile.oauthClientCredentials.clientId,
              clientSecret: publicSecret(
                profile.oauthClientCredentials.clientSecret,
              ),
            }
          : undefined,
      };

const publicForwardSsh = (ssh: ForwardSshTunnelConnectivity | undefined) =>
  ssh === undefined
    ? undefined
    : {
        hostname: ssh.hostname,
        username: ssh.username,
        port: ssh.port,
      };

const publicPrivateConnectivity = (
  value: PrivateConnectivity | ConnectionProfileProps["privateConnectivity"],
  project: string,
  location: string,
) =>
  value?.privateConnection === undefined
    ? undefined
    : {
        privateConnection: privateConnectionOf(
          value.privateConnection,
          project,
          location,
        ),
      };

const secretChanged = (
  newsHasSecret: boolean,
  publicPrevious: unknown,
  publicNext: unknown,
) => newsHasSecret || fingerprint(publicPrevious) !== fingerprint(publicNext);

const mysqlHasSecret = (mysql: MysqlProfile | undefined) =>
  mysql?.password !== undefined ||
  mysql?.sslConfig?.clientCertificate !== undefined ||
  mysql?.sslConfig?.clientKey !== undefined ||
  mysql?.sslConfig?.caCertificate !== undefined;

const postgresqlHasSecret = (postgresql: PostgresqlProfile | undefined) =>
  postgresql?.password !== undefined ||
  postgresql?.sslConfig?.serverVerification?.caCertificate !== undefined ||
  postgresql?.sslConfig?.serverAndClientVerification?.caCertificate !==
    undefined ||
  postgresql?.sslConfig?.serverAndClientVerification?.clientCertificate !==
    undefined ||
  postgresql?.sslConfig?.serverAndClientVerification?.clientKey !== undefined;

const oracleHasSecret = (oracle: OracleProfile | undefined) =>
  oracle?.password !== undefined ||
  oracle?.oracleSslConfig?.caCertificate !== undefined ||
  oracle?.oracleAsmConfig?.password !== undefined ||
  oracle?.oracleAsmConfig?.oracleSslConfig?.caCertificate !== undefined;

const sqlServerHasSecret = (sqlserver: SqlServerProfile | undefined) =>
  sqlserver?.password !== undefined ||
  sqlserver?.sslConfig?.encryptionAndServerValidation?.caCertificate !==
    undefined;

const mongodbHasSecret = (mongodb: MongodbProfile | undefined) =>
  mongodb?.password !== undefined ||
  mongodb?.sslConfig?.clientCertificate !== undefined ||
  mongodb?.sslConfig?.clientKey !== undefined ||
  mongodb?.sslConfig?.caCertificate !== undefined;

const salesforceHasSecret = (salesforce: SalesforceProfile | undefined) =>
  salesforce?.userCredentials?.password !== undefined ||
  salesforce?.userCredentials?.securityToken !== undefined ||
  salesforce?.oauth2ClientCredentials?.clientSecret !== undefined;

const sfmcHasSecret = (profile: SalesforceMarketingCloudProfile | undefined) =>
  profile?.oauthClientCredentials?.clientSecret?.rawValue !== undefined;

const serviceNowHasSecret = (profile: ServiceNowProfile | undefined) =>
  profile?.userPasswordCredentials?.password?.rawValue !== undefined ||
  profile?.oauthClientCredentials?.clientSecret?.rawValue !== undefined;

const dataverseHasSecret = (profile: DataverseProfile | undefined) =>
  profile?.oauthClientCredentials?.clientSecret?.rawValue !== undefined;

const sshHasSecret = (ssh: ForwardSshTunnelConnectivity | undefined) =>
  ssh?.password !== undefined || ssh?.privateKey !== undefined;

const toAttrs = (
  profile: ds.ConnectionProfile,
  project: string,
  locationHint: string,
) => {
  const name = profile.name ?? "";
  const parsed = parseName(name, "connectionProfiles", locationHint);
  return {
    name,
    connectionProfileId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || locationHint,
    displayName: profile.displayName,
    labels: userLabels(profile.labels),
    mysqlProfile: publicMysql(profile.mysqlProfile),
    postgresqlProfile: publicPostgresql(profile.postgresqlProfile),
    oracleProfile: publicOracle(profile.oracleProfile),
    sqlServerProfile: publicSqlServer(profile.sqlServerProfile),
    mongodbProfile: publicMongodb(profile.mongodbProfile),
    spannerProfile: profile.spannerProfile,
    gcsProfile: profile.gcsProfile,
    bigqueryProfile: emptyMessage(profile.bigqueryProfile),
    salesforceProfile: publicSalesforce(profile.salesforceProfile),
    salesforceMarketingCloudProfile: publicSfmc(
      profile.salesforceMarketingCloudProfile,
    ),
    serviceNowProfile: publicServiceNow(profile.serviceNowProfile),
    dataverseProfile: publicDataverse(profile.dataverseProfile),
    staticServiceIpConnectivity: emptyMessage(
      profile.staticServiceIpConnectivity,
    ),
    forwardSshConnectivity: publicForwardSsh(profile.forwardSshConnectivity),
    privateConnectivity: profile.privateConnectivity,
    satisfiesPzi: profile.satisfiesPzi,
    satisfiesPzs: profile.satisfiesPzs,
    createTime: profile.createTime,
    updateTime: profile.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ds
        .getProjectsLocationsConnectionProfiles({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    collectPages(
      ds.listProjectsLocationsConnectionProfiles.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.connectionProfiles,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
    ),
  );

const connectivityOf = (
  news: ConnectionProfileProps,
  project: string,
  location: string,
) => ({
  staticServiceIpConnectivity: emptyMessage(news.staticServiceIpConnectivity),
  forwardSshConnectivity: news.forwardSshConnectivity,
  privateConnectivity: publicPrivateConnectivity(
    news.privateConnectivity,
    project,
    location,
  ),
});

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
        mysqlProfile: olds?.mysqlProfile ?? output?.mysqlProfile,
        postgresqlProfile: olds?.postgresqlProfile ?? output?.postgresqlProfile,
        oracleProfile: olds?.oracleProfile ?? output?.oracleProfile,
        sqlServerProfile: olds?.sqlServerProfile ?? output?.sqlServerProfile,
        mongodbProfile: olds?.mongodbProfile ?? output?.mongodbProfile,
        spannerProfile: olds?.spannerProfile ?? output?.spannerProfile,
        gcsProfile: olds?.gcsProfile ?? output?.gcsProfile,
        bigqueryProfile: olds?.bigqueryProfile ?? output?.bigqueryProfile,
        salesforceProfile: olds?.salesforceProfile ?? output?.salesforceProfile,
        salesforceMarketingCloudProfile:
          olds?.salesforceMarketingCloudProfile ??
          output?.salesforceMarketingCloudProfile,
        serviceNowProfile: olds?.serviceNowProfile ?? output?.serviceNowProfile,
        dataverseProfile: olds?.dataverseProfile ?? output?.dataverseProfile,
      });
      const nextKind = kindOf(news) || previousKind;
      const previousSpanner =
        olds?.spannerProfile?.database ?? output?.spannerProfile?.database;
      const nextSpanner = news.spannerProfile?.database ?? previousSpanner;
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
          (nextKind === "spanner" &&
            previousSpanner !== undefined &&
            nextSpanner !== undefined &&
            previousSpanner !== nextSpanner),
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
      const attrs = toAttrs(existing, env.project, location);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
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
      const connectivity = connectivityOf(news, env.project, location);
      const body: ds.ConnectionProfile = {
        displayName,
        labels: desiredLabels,
        mysqlProfile: news.mysqlProfile,
        postgresqlProfile: news.postgresqlProfile,
        oracleProfile: news.oracleProfile,
        sqlServerProfile: news.sqlServerProfile,
        mongodbProfile: news.mongodbProfile,
        spannerProfile: news.spannerProfile,
        gcsProfile: news.gcsProfile,
        bigqueryProfile: emptyMessage(news.bigqueryProfile),
        salesforceProfile: news.salesforceProfile,
        salesforceMarketingCloudProfile: news.salesforceMarketingCloudProfile,
        serviceNowProfile: news.serviceNowProfile,
        dataverseProfile: news.dataverseProfile,
        ...connectivity,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        yield* ds
          .createProjectsLocationsConnectionProfiles({
            parent: locationParent(env.project, location),
            connectionProfileId,
            force: news.force,
            validateOnly: news.validateOnly,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
            Effect.flatMap((created) => settleOperation(created)),
            // Datastream intermittently fails the create operation with
            // INTERNAL ("an internal error has occurred") under load.
            Effect.retry({
              while: (error) =>
                error._tag === "GCP.OperationFailed" && error.code === 13,
              times: 4,
              schedule: Schedule.exponential("5 seconds"),
            }),
          );
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const mysqlChanged =
        news.mysqlProfile !== undefined &&
        secretChanged(
          mysqlHasSecret(news.mysqlProfile),
          publicMysql(current.mysqlProfile),
          publicMysql(news.mysqlProfile),
        );
      const postgresqlChanged =
        news.postgresqlProfile !== undefined &&
        secretChanged(
          postgresqlHasSecret(news.postgresqlProfile),
          publicPostgresql(current.postgresqlProfile),
          publicPostgresql(news.postgresqlProfile),
        );
      const oracleChanged =
        news.oracleProfile !== undefined &&
        secretChanged(
          oracleHasSecret(news.oracleProfile),
          publicOracle(current.oracleProfile),
          publicOracle(news.oracleProfile),
        );
      const sqlServerChanged =
        news.sqlServerProfile !== undefined &&
        secretChanged(
          sqlServerHasSecret(news.sqlServerProfile),
          publicSqlServer(current.sqlServerProfile),
          publicSqlServer(news.sqlServerProfile),
        );
      const mongodbChanged =
        news.mongodbProfile !== undefined &&
        secretChanged(
          mongodbHasSecret(news.mongodbProfile),
          publicMongodb(current.mongodbProfile),
          publicMongodb(news.mongodbProfile),
        );
      const gcsChanged =
        news.gcsProfile !== undefined &&
        fingerprint(current.gcsProfile) !== fingerprint(news.gcsProfile);
      const salesforceChanged =
        news.salesforceProfile !== undefined &&
        secretChanged(
          salesforceHasSecret(news.salesforceProfile),
          publicSalesforce(current.salesforceProfile),
          publicSalesforce(news.salesforceProfile),
        );
      const sfmcChanged =
        news.salesforceMarketingCloudProfile !== undefined &&
        secretChanged(
          sfmcHasSecret(news.salesforceMarketingCloudProfile),
          publicSfmc(current.salesforceMarketingCloudProfile),
          publicSfmc(news.salesforceMarketingCloudProfile),
        );
      const serviceNowChanged =
        news.serviceNowProfile !== undefined &&
        secretChanged(
          serviceNowHasSecret(news.serviceNowProfile),
          publicServiceNow(current.serviceNowProfile),
          publicServiceNow(news.serviceNowProfile),
        );
      const dataverseChanged =
        news.dataverseProfile !== undefined &&
        secretChanged(
          dataverseHasSecret(news.dataverseProfile),
          publicDataverse(current.dataverseProfile),
          publicDataverse(news.dataverseProfile),
        );
      const desiredPrivate = publicPrivateConnectivity(
        news.privateConnectivity,
        env.project,
        location,
      );
      const staticChanged =
        news.staticServiceIpConnectivity !== undefined &&
        fingerprint(emptyMessage(current.staticServiceIpConnectivity)) !==
          fingerprint(emptyMessage(news.staticServiceIpConnectivity));
      const sshChanged =
        news.forwardSshConnectivity !== undefined &&
        secretChanged(
          sshHasSecret(news.forwardSshConnectivity),
          publicForwardSsh(current.forwardSshConnectivity),
          publicForwardSsh(news.forwardSshConnectivity),
        );
      const privateChanged =
        news.privateConnectivity !== undefined &&
        fingerprint(current.privateConnectivity) !==
          fingerprint(desiredPrivate);
      const mask = fieldMask([
        labelsChanged && "labels",
        displayNameChanged && "displayName",
        mysqlChanged && "mysqlProfile",
        postgresqlChanged && "postgresqlProfile",
        oracleChanged && "oracleProfile",
        sqlServerChanged && "sqlServerProfile",
        mongodbChanged && "mongodbProfile",
        gcsChanged && "gcsProfile",
        salesforceChanged && "salesforceProfile",
        sfmcChanged && "salesforceMarketingCloudProfile",
        serviceNowChanged && "serviceNowProfile",
        dataverseChanged && "dataverseProfile",
        staticChanged && "staticServiceIpConnectivity",
        sshChanged && "forwardSshConnectivity",
        privateChanged && "privateConnectivity",
      ]);

      if (mask.length > 0) {
        const patch: ds.ConnectionProfile = { name: current.name ?? name };
        if (labelsChanged) patch.labels = desiredLabels;
        if (displayNameChanged) patch.displayName = displayName;
        if (mysqlChanged) patch.mysqlProfile = news.mysqlProfile;
        if (postgresqlChanged) patch.postgresqlProfile = news.postgresqlProfile;
        if (oracleChanged) patch.oracleProfile = news.oracleProfile;
        if (sqlServerChanged) patch.sqlServerProfile = news.sqlServerProfile;
        if (mongodbChanged) patch.mongodbProfile = news.mongodbProfile;
        if (gcsChanged) patch.gcsProfile = news.gcsProfile;
        if (salesforceChanged) patch.salesforceProfile = news.salesforceProfile;
        if (sfmcChanged) {
          patch.salesforceMarketingCloudProfile =
            news.salesforceMarketingCloudProfile;
        }
        if (serviceNowChanged) patch.serviceNowProfile = news.serviceNowProfile;
        if (dataverseChanged) patch.dataverseProfile = news.dataverseProfile;
        if (staticChanged) {
          patch.staticServiceIpConnectivity =
            connectivity.staticServiceIpConnectivity;
        }
        if (sshChanged) {
          patch.forwardSshConnectivity = connectivity.forwardSshConnectivity;
        }
        if (privateChanged) {
          patch.privateConnectivity = connectivity.privateConnectivity;
        }
        const operation = yield* ds.patchProjectsLocationsConnectionProfiles({
          name: current.name ?? name,
          updateMask: mask,
          force: news.force,
          validateOnly: news.validateOnly,
          body: patch,
        });
        yield* settleOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* ds
        .deleteProjectsLocationsConnectionProfiles({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag(["NotFound", "Conflict"], () =>
            Effect.succeed(undefined),
          ),
        );
      yield* settleOperation(operation, { notFoundOk: true });
      yield* waitUntilGone(getByName(output.name), output.name, {
        times: 15,
        interval: "2 seconds",
      }).pipe(
        Effect.catchTag(
          "GCP.Datastream.ResourceStillExists",
          () => Effect.void,
        ),
      );
    }),
  });
