import * as bigqueryconnection from "@distilled.cloud/gcp/bigqueryconnection_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 60;
const MULTI_REGION = new Set(["us", "eu"]);

export type SparkHistoryServerConfig = {
  /**
   * Existing Dataproc cluster used as a Spark History Server, as
   * `projects/{project}/regions/{region}/clusters/{cluster}`.
   */
  dataprocCluster?: string;
};

export type MetastoreServiceConfig = {
  /**
   * Existing Dataproc Metastore service, as
   * `projects/{project}/locations/{location}/services/{service}`.
   */
  metastoreService?: string;
};

export type SparkProperties = {
  /** Spark History Server configuration. */
  sparkHistoryServerConfig?: SparkHistoryServerConfig;
  /** Dataproc Metastore service configuration. */
  metastoreServiceConfig?: MetastoreServiceConfig;
};

export type CloudSqlCredential = {
  /** Database username. */
  username?: string;
  /** Database password. Input-only — omitted from attributes. */
  password?: string;
};

export type CloudSqlProperties = {
  /**
   * Cloud SQL instance id in the form `project:location:instance`.
   */
  instanceId?: string;
  /** Database engine. */
  type?: "DATABASE_TYPE_UNSPECIFIED" | "POSTGRES" | "MYSQL" | (string & {});
  /** Database name. */
  database?: string;
  /** Cloud SQL credential. Input-only password. */
  credential?: CloudSqlCredential;
};

export type CloudResourceProperties = {
  /**
   * Google-managed service account for this connection. Output-only —
   * ignored on create.
   */
  serviceAccountId?: string;
};

export type AwsAccessRole = {
  /** Customer AWS IAM role that trusts the Google-owned AWS identity. */
  iamRoleId?: string;
};

export type AwsProperties = {
  /** AWS IAM role assumption. */
  accessRole?: AwsAccessRole;
};

export type CloudSpannerProperties = {
  /**
   * Cloud Spanner database as `project/instance/database`.
   */
  database?: string;
  /** Fine-grained access control database role. */
  databaseRole?: string;
  /** Whether to read from Spanner in parallel. */
  useParallelism?: boolean;
  /**
   * Deprecated. Prefer `useDataBoost`. Requires `useParallelism`.
   */
  useServerlessAnalytics?: boolean;
  /** Execute via Spanner independent compute. Requires `useParallelism`. */
  useDataBoost?: boolean;
  /** Max parallelism per query. Requires `useParallelism` and `useDataBoost`. */
  maxParallelism?: number;
};

export type SalesforceDataCloudProperties = {
  /** Salesforce DataCloud instance URL. */
  instanceUri?: string;
  /** Salesforce tenant id. */
  tenantId?: string;
};

export type AzureProperties = {
  /** Customer Azure Active Directory tenant that hosts the data. */
  customerTenantId?: string;
  /** Redirect URL after consent during connection setup. */
  redirectUri?: string;
  /** Customer Azure AD application client id for federated auth. */
  federatedApplicationClientId?: string;
};

export type ConnectorSecret = {
  /** Input-only plaintext secret. */
  plaintext?: string;
};

export type ConnectorUsernamePassword = {
  /** Username. */
  username?: string;
  /** Password secret. */
  password?: ConnectorSecret;
};

export type ConnectorParameterValue = {
  int32Value?: number;
  stringValue?: string;
  boolValue?: boolean;
  doubleValue?: number;
  secretValue?: ConnectorSecret;
};

export type ConnectorAuthentication = {
  usernamePassword?: ConnectorUsernamePassword;
  parameters?: Record<string, ConnectorParameterValue | undefined>;
};

export type ConnectorNetwork = {
  /** Private Service Connect network attachment. */
  privateServiceConnect?: {
    networkAttachment?: string;
  };
};

export type ConnectorAsset = {
  database?: string;
  googleCloudResource?: string;
};

export type ConnectorEndpoint = {
  /** Host and port as `hostname:port`. */
  hostPort?: string;
};

export type ConnectorConfiguration = {
  /**
   * Connector id (for example `google-alloydb`). Immutable — changing it
   * replaces the connection.
   */
  connectorId?: string;
  authentication?: ConnectorAuthentication;
  network?: ConnectorNetwork;
  parameters?: Record<string, ConnectorParameterValue | undefined>;
  asset?: ConnectorAsset;
  endpoint?: ConnectorEndpoint;
};

export type ConnectionKind =
  | "cloudResource"
  | "cloudSql"
  | "cloudSpanner"
  | "spark"
  | "aws"
  | "azure"
  | "salesforceDataCloud"
  | "configuration";

export type ConnectionProps = {
  /**
   * Connection id (the `{connection}` segment of
   * `projects/{project}/locations/{location}/connections/{connection}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must contain only letters, numbers, and underscores, start
   * with a letter or underscore, and be at most 64 characters. Immutable —
   * changing it replaces the connection.
   */
  connectionId?: string;
  /**
   * BigQuery connection location (`us-central1`, `US`, `EU`,
   * `aws-us-east-1`, …). Immutable — changing it replaces the connection.
   * Regional ids are lowercased; multi-regions `US` / `EU` stay uppercase.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name.
   */
  friendlyName?: string;
  /**
   * Human-readable description. Connections have no labels, so Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is stored
   * in a `[alchemy …]` prefix for `list` / nuke.
   */
  description?: string;
  /**
   * Cloud KMS key used to encrypt credentials, as
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   * Immutable — changing it replaces the connection.
   */
  kmsKeyName?: string;
  /**
   * Cloud resource connection (GCS, Bigtable, and other GCP resources).
   * Default when no other connection type is set. Cheap to create — no
   * extra resources required.
   */
  cloudResource?: CloudResourceProperties;
  /**
   * Cloud SQL connection. Requires an existing Cloud SQL instance,
   * database, and credential.
   */
  cloudSql?: CloudSqlProperties;
  /**
   * Cloud Spanner connection. Requires an existing Spanner database.
   */
  cloudSpanner?: CloudSpannerProperties;
  /**
   * Apache Spark stored-procedure connection.
   */
  spark?: SparkProperties;
  /**
   * BigQuery Omni AWS connection. Location must be an AWS region such as
   * `aws-us-east-1`.
   */
  aws?: AwsProperties;
  /**
   * BigQuery Omni Azure connection. Location must be an Azure region such
   * as `azure-eastus2`.
   */
  azure?: AzureProperties;
  /**
   * Salesforce DataCloud connection. Partner projects only.
   */
  salesforceDataCloud?: SalesforceDataCloudProperties;
  /**
   * Connector-framework configuration (AlloyDB, MySQL, PostgreSQL, …).
   * Mutually exclusive with the typed property blocks. `connectorId` is
   * immutable.
   */
  configuration?: ConnectorConfiguration;
};

export type Connection = Resource<
  "GCP.BigQueryConnection.Connection",
  ConnectionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/connections/{connection}`. */
    name: string;
    /** Connection id (last path segment). */
    connectionId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, `US`, …). */
    location: string;
    /** User-friendly display name. */
    friendlyName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Cloud KMS key used for credential encryption, if any. */
    kmsKeyName: string | undefined;
    /** True when a credential is configured. */
    hasCredential: boolean;
    /** RFC3339 creation timestamp (millis since epoch as a string). */
    creationTime: string | undefined;
    /** RFC3339 last-update timestamp (millis since epoch as a string). */
    lastModifiedTime: string | undefined;
    /** Connection type currently configured. */
    kind: ConnectionKind;
    /**
     * Google-managed service account used by jobs that use this
     * connection, if the type exposes one.
     */
    serviceAccountId: string | undefined;
    /** Cloud resource properties, if this is a cloud-resource connection. */
    cloudResource: CloudResourceProperties | undefined;
    /** Cloud SQL properties (password omitted). */
    cloudSql: CloudSqlProperties | undefined;
    /** Cloud Spanner properties. */
    cloudSpanner: CloudSpannerProperties | undefined;
    /** Spark properties. */
    spark: SparkProperties | undefined;
    /** AWS properties. */
    aws: AwsProperties | undefined;
    /** Azure properties. */
    azure: AzureProperties | undefined;
    /** Salesforce DataCloud properties. */
    salesforceDataCloud: SalesforceDataCloudProperties | undefined;
    /** Connector-framework configuration (secrets omitted). */
    configuration: ConnectorConfiguration | undefined;
  },
  never,
  Providers
>;

/**
 * A BigQuery Connection to an external data source.
 *
 * Connections have no resource labels. Alchemy stamps ownership into the
 * description (`[alchemy alchemy-stack=… alchemy-stage=… alchemy-id=…]`)
 * so `list` / `pnpm nuke:gcp` can find them.
 *
 * When no connection type is set, Alchemy creates a Cloud resource
 * connection (`cloudResource: {}`) — the cheapest type, with no extra
 * Cloud SQL / Spanner / AWS resources. `connectionId`, `location`,
 * `kmsKeyName`, and the connection type are immutable.
 *
 * ### Creating a Connection
 * **Example:** Generated Cloud resource connection
 * ```typescript
 * const gcs = yield* GCP.BigQueryConnection.Connection("Gcs", {});
 * ```
 *
 * **Example:** Named Cloud resource connection
 * ```typescript
 * const gcs = yield* GCP.BigQueryConnection.Connection("Gcs", {
 *   connectionId: "app-gcs",
 *   location: "us-central1",
 *   friendlyName: "GCS access",
 *   description: "delegates to Cloud Storage",
 *   cloudResource: {},
 * });
 * ```
 *
 * ### Spark
 * **Example:** Spark stored-procedure connection
 * ```typescript
 * const spark = yield* GCP.BigQueryConnection.Connection("Spark", {
 *   spark: {},
 * });
 * ```
 *
 * ### Cloud SQL
 * Cloud SQL connections need a live instance, database, and password —
 * skip them in cheap tests.
 *
 * **Example:** Postgres Cloud SQL connection
 * ```typescript
 * const sql = yield* GCP.BigQueryConnection.Connection("Sql", {
 *   location: "US",
 *   cloudSql: {
 *     instanceId: "my-project:us-central1:app-sql",
 *     database: "app",
 *     type: "POSTGRES",
 *     credential: { username: "app", password: "secret" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category BigQueryConnection
 */
export const Connection = Resource<Connection>(
  "GCP.BigQueryConnection.Connection",
);

export class ConnectionNotResolved extends Data.TaggedError(
  "GCP.BigQueryConnection.ConnectionNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) => {
  const raw = lastSegment(location ?? fallback);
  const lower = raw.toLowerCase();
  return MULTI_REGION.has(lower) ? lower.toUpperCase() : lower;
};

const resourceName = (
  project: string,
  location: string,
  connectionId: string,
) => `projects/${project}/locations/${location}/connections/${connectionId}`;

const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const connectionsAt = parts.lastIndexOf("connections");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    connectionId:
      connectionsAt >= 0 && parts[connectionsAt + 1]
        ? parts[connectionsAt + 1]!
        : lastSegment(name),
  };
};

const toId = (
  id: string,
  connectionId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (connectionId !== undefined) return connectionId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
      delimiter: "_",
    });
    const sanitized = generated.replaceAll("-", "_");
    return /^[a-z_]/.test(sanitized)
      ? sanitized
      : `c${sanitized}`.slice(0, MAX_NAME_LENGTH);
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const specifiedKind = (value: {
  cloudSql?: unknown;
  cloudSpanner?: unknown;
  spark?: unknown;
  aws?: unknown;
  azure?: unknown;
  salesforceDataCloud?: unknown;
  configuration?: unknown;
  cloudResource?: unknown;
}): ConnectionKind | undefined => {
  if (value.cloudSql !== undefined) return "cloudSql";
  if (value.cloudSpanner !== undefined) return "cloudSpanner";
  if (value.spark !== undefined) return "spark";
  if (value.aws !== undefined) return "aws";
  if (value.azure !== undefined) return "azure";
  if (value.salesforceDataCloud !== undefined) return "salesforceDataCloud";
  if (value.configuration !== undefined) return "configuration";
  if (value.cloudResource !== undefined) return "cloudResource";
  return undefined;
};

const kindOf = (value: Parameters<typeof specifiedKind>[0]): ConnectionKind =>
  specifiedKind(value) ?? "cloudResource";

const toCloudSql = (
  properties: bigqueryconnection.CloudSqlProperties | undefined,
): CloudSqlProperties | undefined => {
  if (properties === undefined) return undefined;
  return {
    instanceId: properties.instanceId,
    type: properties.type,
    database: properties.database,
    credential: properties.credential
      ? { username: properties.credential.username }
      : undefined,
  };
};

const toSpark = (
  properties: bigqueryconnection.SparkProperties | undefined,
): SparkProperties | undefined => {
  if (properties === undefined) return undefined;
  return {
    sparkHistoryServerConfig: properties.sparkHistoryServerConfig,
    metastoreServiceConfig: properties.metastoreServiceConfig,
  };
};

const toAws = (
  properties: bigqueryconnection.AwsProperties | undefined,
): AwsProperties | undefined => {
  if (properties === undefined) return undefined;
  return {
    accessRole: properties.accessRole
      ? { iamRoleId: properties.accessRole.iamRoleId }
      : undefined,
  };
};

const toAzure = (
  properties: bigqueryconnection.AzureProperties | undefined,
): AzureProperties | undefined => {
  if (properties === undefined) return undefined;
  return {
    customerTenantId: properties.customerTenantId,
    redirectUri: properties.redirectUri,
    federatedApplicationClientId: properties.federatedApplicationClientId,
  };
};

const toSpanner = (
  properties: bigqueryconnection.CloudSpannerProperties | undefined,
): CloudSpannerProperties | undefined => {
  if (properties === undefined) return undefined;
  return {
    database: properties.database,
    databaseRole: properties.databaseRole,
    useParallelism: properties.useParallelism,
    useServerlessAnalytics: properties.useServerlessAnalytics,
    useDataBoost: properties.useDataBoost,
    maxParallelism: properties.maxParallelism,
  };
};

const toSalesforce = (
  properties: bigqueryconnection.SalesforceDataCloudProperties | undefined,
): SalesforceDataCloudProperties | undefined => {
  if (properties === undefined) return undefined;
  return {
    instanceUri: properties.instanceUri,
    tenantId: properties.tenantId,
  };
};

const toSecret = (
  secret: bigqueryconnection.ConnectorConfigurationSecret | undefined,
): ConnectorSecret | undefined => {
  if (secret === undefined) return undefined;
  return secret.plaintext !== undefined
    ? { plaintext: secret.plaintext }
    : undefined;
};

const toParameterMap = (
  parameters:
    | bigqueryconnection.ConnectorConfigurationParameterValueMap
    | undefined,
): Record<string, ConnectorParameterValue | undefined> | undefined => {
  if (parameters === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [
      key,
      value
        ? {
            int32Value: value.int32Value,
            stringValue: value.stringValue,
            boolValue: value.boolValue,
            doubleValue: value.doubleValue,
            secretValue: toSecret(value.secretValue),
          }
        : undefined,
    ]),
  );
};

const toConfiguration = (
  configuration: bigqueryconnection.ConnectorConfiguration | undefined,
): ConnectorConfiguration | undefined => {
  if (configuration === undefined) return undefined;
  return {
    connectorId: configuration.connectorId,
    authentication: configuration.authentication
      ? {
          usernamePassword: configuration.authentication.usernamePassword
            ? {
                username:
                  configuration.authentication.usernamePassword.username,
                password: toSecret(
                  configuration.authentication.usernamePassword.password,
                ),
              }
            : undefined,
          parameters: toParameterMap(configuration.authentication.parameters),
        }
      : undefined,
    network: configuration.network,
    parameters: toParameterMap(configuration.parameters),
    asset: configuration.asset,
    endpoint: configuration.endpoint,
  };
};

const toCloudResource = (
  properties: bigqueryconnection.CloudResourceProperties | undefined,
  kind: ConnectionKind,
): CloudResourceProperties | undefined => {
  if (properties === undefined) {
    return kind === "cloudResource" ? {} : undefined;
  }
  return { serviceAccountId: properties.serviceAccountId };
};

const serviceAccountOf = (
  connection: bigqueryconnection.Connection,
): string | undefined =>
  connection.cloudResource?.serviceAccountId ??
  connection.cloudSql?.serviceAccountId ??
  connection.spark?.serviceAccountId ??
  connection.configuration?.authentication?.serviceAccount ??
  connection.aws?.accessRole?.identity ??
  connection.azure?.identity ??
  connection.salesforceDataCloud?.identity;

const toAttrs = (
  connection: bigqueryconnection.Connection,
  project: string,
) => {
  const name = connection.name ?? "";
  const parsed = parseName(name);
  const kind = kindOf(connection);
  const parsedDescription = parseDescription(connection.description);
  return {
    name,
    connectionId: parsed.connectionId,
    project: parsed.project || project,
    location: parsed.location,
    friendlyName: connection.friendlyName,
    description: parsedDescription.description,
    kmsKeyName: connection.kmsKeyName,
    hasCredential: connection.hasCredential === true,
    creationTime: connection.creationTime,
    lastModifiedTime: connection.lastModifiedTime,
    kind,
    serviceAccountId: serviceAccountOf(connection),
    cloudResource: toCloudResource(connection.cloudResource, kind),
    cloudSql: toCloudSql(connection.cloudSql),
    cloudSpanner: toSpanner(connection.cloudSpanner),
    spark: toSpark(connection.spark),
    aws: toAws(connection.aws),
    azure: toAzure(connection.azure),
    salesforceDataCloud: toSalesforce(connection.salesforceDataCloud),
    configuration: toConfiguration(connection.configuration),
  };
};

const writableSpark = (properties: SparkProperties | undefined) => {
  if (properties === undefined) return undefined;
  return {
    sparkHistoryServerConfig: properties.sparkHistoryServerConfig,
    metastoreServiceConfig: properties.metastoreServiceConfig,
  };
};

const writableAws = (properties: AwsProperties | undefined) => {
  if (properties === undefined) return undefined;
  return {
    accessRole: properties.accessRole
      ? { iamRoleId: properties.accessRole.iamRoleId }
      : undefined,
  };
};

const writableAzure = (properties: AzureProperties | undefined) => {
  if (properties === undefined) return undefined;
  return {
    customerTenantId: properties.customerTenantId,
    redirectUri: properties.redirectUri,
    federatedApplicationClientId: properties.federatedApplicationClientId,
  };
};

const writableSpanner = (properties: CloudSpannerProperties | undefined) => {
  if (properties === undefined) return undefined;
  return {
    database: properties.database,
    databaseRole: properties.databaseRole,
    useParallelism: properties.useParallelism,
    useServerlessAnalytics: properties.useServerlessAnalytics,
    useDataBoost: properties.useDataBoost,
    maxParallelism: properties.maxParallelism,
  };
};

const writableSalesforce = (
  properties: SalesforceDataCloudProperties | undefined,
) => {
  if (properties === undefined) return undefined;
  return {
    instanceUri: properties.instanceUri,
    tenantId: properties.tenantId,
  };
};

const writableConfiguration = (
  configuration: ConnectorConfiguration | undefined,
) => {
  if (configuration === undefined) return undefined;
  return {
    connectorId: configuration.connectorId,
    authentication: configuration.authentication,
    network: configuration.network,
    parameters: configuration.parameters,
    asset: configuration.asset,
    endpoint: configuration.endpoint,
  };
};

const toCreateBody = (
  news: ConnectionProps,
  ownership: Record<string, string>,
): bigqueryconnection.Connection => {
  const kind = kindOf(news);
  const body: bigqueryconnection.Connection = {
    friendlyName: news.friendlyName,
    description: encodeDescription(ownership, news.description),
    kmsKeyName: news.kmsKeyName,
  };
  switch (kind) {
    case "cloudSql":
      body.cloudSql = news.cloudSql;
      break;
    case "cloudSpanner":
      body.cloudSpanner = news.cloudSpanner;
      break;
    case "spark":
      body.spark = news.spark ?? {};
      break;
    case "aws":
      body.aws = news.aws;
      break;
    case "azure":
      body.azure = news.azure;
      break;
    case "salesforceDataCloud":
      body.salesforceDataCloud = news.salesforceDataCloud;
      break;
    case "configuration":
      body.configuration = news.configuration;
      break;
    default:
      body.cloudResource = {};
      break;
  }
  return body;
};

const getByName = (name: string) =>
  bigqueryconnection
    .getProjectsLocationsConnections({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwnedAt = (parent: string, project: string) =>
  bigqueryconnection.listProjectsLocationsConnections
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.connections ?? [])),
      Stream.filter((connection) => hasOwnershipMarker(connection.description)),
      Stream.map((connection) => toAttrs(connection, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const ConnectionProvider = () =>
  Provider.succeed(Connection, {
    stables: [
      "name",
      "connectionId",
      "project",
      "location",
      "kind",
      "kmsKeyName",
      "creationTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;

      const previousId = olds?.connectionId ?? output?.connectionId;
      const nextId = news.connectionId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const locationChanged = previousLocation !== nextLocation;

      const previousKms = olds?.kmsKeyName ?? output?.kmsKeyName ?? "";
      const nextKms = news.kmsKeyName ?? previousKms;
      const kmsChanged = nextKms !== previousKms;

      const previousKind =
        specifiedKind(olds ?? {}) ??
        specifiedKind(output ?? {}) ??
        "cloudResource";
      const nextKind = specifiedKind(news) ?? previousKind;
      const kindChanged = previousKind !== nextKind;

      const previousConnector =
        olds?.configuration?.connectorId ?? output?.configuration?.connectorId;
      const nextConnector =
        news.configuration?.connectorId ?? previousConnector;
      const connectorChanged =
        previousConnector !== undefined &&
        nextConnector !== undefined &&
        nextConnector !== previousConnector;

      if (
        !idChanged &&
        !locationChanged &&
        !kmsChanged &&
        !kindChanged &&
        !connectorChanged
      ) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst: !idChanged && !locationChanged,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const connectionId = yield* toId(
        id,
        olds?.connectionId,
        output?.connectionId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, connectionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(
        id,
        parseDescription(existing.description).labels,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const wildcard = yield* listOwnedAt(
          parentOf(env.project, "-"),
          env.project,
        );
        if (wildcard.length > 0) return wildcard;
        const fallback = yield* Effect.forEach(
          [...new Set(["us-central1", env.region, "US", "EU", "us-east1"])],
          (location) =>
            listOwnedAt(parentOf(env.project, location), env.project),
          { concurrency: 4 },
        );
        const seen = new Set<string>();
        return fallback.flat().filter((connection) => {
          if (seen.has(connection.name)) return false;
          seen.add(connection.name);
          return true;
        });
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const connectionId = yield* toId(
        id,
        news.connectionId,
        output?.connectionId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, connectionId);
      const parent = parentOf(env.project, location);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* bigqueryconnection
          .createProjectsLocationsConnections({
            parent,
            connectionId,
            body: toCreateBody(news, ownership),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ConnectionNotResolved({ name });
      }

      const updateMask: string[] = [];
      const body: bigqueryconnection.Connection = {};

      if ((current.friendlyName ?? "") !== (news.friendlyName ?? "")) {
        updateMask.push("friendlyName");
        body.friendlyName = news.friendlyName;
      }
      if ((current.description ?? "") !== desiredDescription) {
        updateMask.push("description");
        body.description = desiredDescription;
      }

      const kind = kindOf(news);
      if (kind === "cloudSql" && news.cloudSql !== undefined) {
        const observedSql = {
          instanceId: current.cloudSql?.instanceId,
          type: current.cloudSql?.type,
          database: current.cloudSql?.database,
        };
        const desiredSql = {
          instanceId: news.cloudSql.instanceId,
          type: news.cloudSql.type,
          database: news.cloudSql.database,
        };
        if (!jsonEqual(observedSql, desiredSql)) {
          updateMask.push("cloudSql");
          body.cloudSql = news.cloudSql;
        }
      }
      if (
        kind === "cloudSpanner" &&
        news.cloudSpanner !== undefined &&
        !jsonEqual(
          writableSpanner(toSpanner(current.cloudSpanner)),
          writableSpanner(news.cloudSpanner),
        )
      ) {
        updateMask.push("cloudSpanner");
        body.cloudSpanner = news.cloudSpanner;
      }
      if (
        kind === "spark" &&
        !jsonEqual(
          writableSpark(toSpark(current.spark)),
          writableSpark(news.spark ?? {}),
        )
      ) {
        updateMask.push("spark");
        body.spark = news.spark ?? {};
      }
      if (
        kind === "aws" &&
        news.aws !== undefined &&
        !jsonEqual(writableAws(toAws(current.aws)), writableAws(news.aws))
      ) {
        updateMask.push("aws");
        body.aws = news.aws;
      }
      if (
        kind === "azure" &&
        news.azure !== undefined &&
        !jsonEqual(
          writableAzure(toAzure(current.azure)),
          writableAzure(news.azure),
        )
      ) {
        updateMask.push("azure");
        body.azure = news.azure;
      }
      if (
        kind === "salesforceDataCloud" &&
        news.salesforceDataCloud !== undefined &&
        !jsonEqual(
          writableSalesforce(toSalesforce(current.salesforceDataCloud)),
          writableSalesforce(news.salesforceDataCloud),
        )
      ) {
        updateMask.push("salesforceDataCloud");
        body.salesforceDataCloud = news.salesforceDataCloud;
      }
      if (
        kind === "configuration" &&
        news.configuration !== undefined &&
        !jsonEqual(
          writableConfiguration(toConfiguration(current.configuration)),
          writableConfiguration(news.configuration),
        )
      ) {
        updateMask.push("configuration");
        body.configuration = news.configuration;
      }

      if (updateMask.length > 0) {
        const patched = yield* bigqueryconnection
          .patchProjectsLocationsConnections({
            name,
            updateMask: updateMask.join(","),
            body,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (patched === undefined) {
          const created = yield* bigqueryconnection
            .createProjectsLocationsConnections({
              parent,
              connectionId,
              body: toCreateBody(news, ownership),
            })
            .pipe(Effect.catchTag("Conflict", () => getByName(name)));
          current = created ?? undefined;
        } else {
          current = patched;
        }
      }

      if (current === undefined) {
        return yield* new ConnectionNotResolved({ name });
      }

      const latest = (yield* getByName(current.name ?? name)) ?? current;
      return toAttrs(latest, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* bigqueryconnection
        .deleteProjectsLocationsConnections({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
