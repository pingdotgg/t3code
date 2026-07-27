import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * Direction of a DMS endpoint relative to the replication:
 * `source` reads from the database, `target` writes to it.
 */
export type EndpointType = "source" | "target";

export interface EndpointProps {
  /**
   * Database-migration endpoint identifier. Must be lowercase, 1-255
   * characters, begin with a letter, and contain only letters, digits, and
   * hyphens (no two consecutive hyphens, no trailing hyphen). If omitted, a
   * deterministic physical name is generated. Changing it replaces the
   * endpoint.
   */
  endpointIdentifier?: string;
  /**
   * Whether this endpoint is the migration `source` or `target`.
   */
  endpointType: EndpointType;
  /**
   * Database engine, e.g. `"mysql"`, `"postgres"`, `"aurora"`, `"s3"`,
   * `"kinesis"`, `"docdb"`. Determines which `*Settings` block applies.
   */
  engineName: string;
  /**
   * User name used to connect to the endpoint database.
   */
  username?: string;
  /**
   * Password used to connect to the endpoint database. Marked sensitive.
   */
  password?: Redacted.Redacted<string>;
  /**
   * Host name of the endpoint database server.
   */
  serverName?: string;
  /**
   * Port the endpoint database listens on.
   */
  port?: number;
  /**
   * Name of the endpoint database.
   */
  databaseName?: string;
  /**
   * Additional attributes accepted by DMS as a semicolon-separated string.
   */
  extraConnectionAttributes?: string;
  /**
   * Customer-managed KMS key for connection-secret encryption. Changing the
   * key replaces the endpoint.
   * @default AWS-owned DMS key
   */
  kmsKeyId?: string;
  /**
   * ARN of a certificate DMS uses for SSL connections to the endpoint.
   */
  certificateArn?: string;
  /**
   * SSL mode for the connection.
   * @default "none"
   */
  sslMode?: dms.DmsSslModeValue;
  /**
   * IAM role ARN DMS assumes to access the endpoint (required for S3,
   * DynamoDB, Kinesis, and other AWS-service targets).
   */
  serviceAccessRoleArn?: string;
  /**
   * Externally-defined table definition JSON (S3/DynamoDB targets).
   */
  externalTableDefinition?: string;
  /** Settings for an Amazon S3 endpoint. */
  s3Settings?: dms.S3Settings;
  /** Settings for an Amazon DynamoDB target endpoint. */
  dynamoDbSettings?: dms.DynamoDbSettings;
  /** Settings for an Amazon Kinesis Data Streams target endpoint. */
  kinesisSettings?: dms.KinesisSettings;
  /** Settings for an Apache Kafka target endpoint. */
  kafkaSettings?: dms.KafkaSettings;
  /** Settings for an OpenSearch/Elasticsearch target endpoint. */
  elasticsearchSettings?: dms.ElasticsearchSettings;
  /** Settings for an Amazon Neptune target endpoint. */
  neptuneSettings?: dms.NeptuneSettings;
  /** Settings for an Amazon Redshift target endpoint. */
  redshiftSettings?: dms.RedshiftSettings;
  /** Settings for a PostgreSQL endpoint. */
  postgreSQLSettings?: dms.PostgreSQLSettings;
  /** Settings for a MySQL endpoint. */
  mySQLSettings?: dms.MySQLSettings;
  /** Settings for an Oracle endpoint. */
  oracleSettings?: dms.OracleSettings;
  /** Settings for a Microsoft SQL Server endpoint. */
  microsoftSQLServerSettings?: dms.MicrosoftSQLServerSettings;
  /** Settings for a MongoDB endpoint. */
  mongoDbSettings?: dms.MongoDbSettings;
  /** Settings for an Amazon DocumentDB endpoint. */
  docDbSettings?: dms.DocDbSettings;
  /** Settings for a Redis target endpoint. */
  redisSettings?: dms.RedisSettings;
  /**
   * User-defined tags for the endpoint.
   */
  tags?: Record<string, string>;
}

export interface Endpoint extends Resource<
  "AWS.DMS.Endpoint",
  EndpointProps,
  {
    /** The endpoint identifier (unique per account/region). */
    endpointIdentifier: string;
    /** The ARN of the endpoint. */
    endpointArn: string;
    /** Whether the endpoint is a `source` or `target`. */
    endpointType: string;
    /** The database engine of the endpoint, e.g. `postgres`, `mysql`. */
    engineName: string;
    /** The current status of the endpoint, e.g. `active`. */
    status: string | undefined;
    /** The tags attached to the endpoint. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Database Migration Service (DMS) endpoint — the source or target
 * database of a replication. Endpoints are metadata-only (they store
 * connection information, not data), so they are free and fast to create.
 * @resource
 * @section Creating Endpoints
 * @example MySQL Source Endpoint
 * ```typescript
 * const source = yield* Endpoint("Source", {
 *   endpointType: "source",
 *   engineName: "mysql",
 *   serverName: "source-db.example.com",
 *   port: 3306,
 *   username: "admin",
 *   password: Redacted.make("super-secret"),
 *   databaseName: "app",
 * });
 * ```
 *
 * @example S3 Target Endpoint
 * ```typescript
 * const target = yield* Endpoint("Target", {
 *   endpointType: "target",
 *   engineName: "s3",
 *   serviceAccessRoleArn: role.roleArn,
 *   s3Settings: {
 *     BucketName: bucket.bucketName,
 *     ServiceAccessRoleArn: role.roleArn,
 *   },
 * });
 * ```
 */
export const Endpoint = Resource<Endpoint>("AWS.DMS.Endpoint");

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

export const EndpointProvider = () =>
  Provider.effect(
    Endpoint,
    Effect.gen(function* () {
      const toName = (id: string, props: EndpointProps) =>
        props.endpointIdentifier
          ? Effect.succeed(props.endpointIdentifier)
          : createPhysicalName({ id, maxLength: 200, lowercase: true });

      // DMS has no get-by-identifier; describeEndpoints with an `endpoint-id`
      // filter returns the single matching endpoint (or ResourceNotFoundFault).
      const findEndpoint = Effect.fn(function* (identifier: string) {
        const response = yield* dms
          .describeEndpoints({
            Filters: [{ Name: "endpoint-id", Values: [identifier] }],
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.Endpoints?.[0];
      });

      const readTags = Effect.fn(function* (arn: string) {
        const response = yield* dms
          .listTagsForResource({ ResourceArn: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return toTagRecord(response?.TagList);
      });

      const toAttrs = Effect.fn(function* (endpoint: dms.Endpoint) {
        if (!endpoint.EndpointIdentifier || !endpoint.EndpointArn) {
          return yield* Effect.fail(
            new Error(
              `DMS endpoint '${endpoint.EndpointIdentifier}' is missing its identifier or ARN`,
            ),
          );
        }
        return {
          endpointIdentifier: endpoint.EndpointIdentifier,
          endpointArn: endpoint.EndpointArn,
          endpointType: endpoint.EndpointType ?? "source",
          engineName: endpoint.EngineName ?? "",
          status: endpoint.Status,
          tags: yield* readTags(endpoint.EndpointArn),
        };
      });

      // Settings blocks and secret material shared by create + modify.
      const buildSettings = (props: EndpointProps) => ({
        Username: props.username,
        Password: props.password,
        ServerName: props.serverName,
        Port: props.port,
        DatabaseName: props.databaseName,
        ExtraConnectionAttributes: props.extraConnectionAttributes,
        CertificateArn: props.certificateArn,
        SslMode: props.sslMode,
        ServiceAccessRoleArn: props.serviceAccessRoleArn,
        ExternalTableDefinition: props.externalTableDefinition,
        S3Settings: props.s3Settings,
        DynamoDbSettings: props.dynamoDbSettings,
        KinesisSettings: props.kinesisSettings,
        KafkaSettings: props.kafkaSettings,
        ElasticsearchSettings: props.elasticsearchSettings,
        NeptuneSettings: props.neptuneSettings,
        RedshiftSettings: props.redshiftSettings,
        PostgreSQLSettings: props.postgreSQLSettings,
        MySQLSettings: props.mySQLSettings,
        OracleSettings: props.oracleSettings,
        MicrosoftSQLServerSettings: props.microsoftSQLServerSettings,
        MongoDbSettings: props.mongoDbSettings,
        DocDbSettings: props.docDbSettings,
        RedisSettings: props.redisSettings,
      });

      return {
        stables: ["endpointIdentifier", "endpointArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? ({} as EndpointProps))) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          // KMS key is create-only.
          if ((news.kmsKeyId ?? undefined) !== (olds?.kmsKeyId ?? undefined)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.endpointIdentifier ??
            (yield* toName(id, olds ?? ({} as EndpointProps)));
          const endpoint = yield* findEndpoint(name);
          if (!endpoint?.EndpointArn) return undefined;
          const attrs = yield* toAttrs(endpoint);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.endpointIdentifier ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* findEndpoint(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            observed = yield* dms
              .createEndpoint({
                EndpointIdentifier: name,
                EndpointType: news.endpointType,
                EngineName: news.engineName,
                KmsKeyId: news.kmsKeyId,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
                ...buildSettings(news),
              })
              .pipe(
                Effect.map((r) => r.Endpoint),
                Effect.catchTag("ResourceAlreadyExistsFault", () =>
                  findEndpoint(name),
                ),
              );
          } else {
            // 3. Sync — the endpoint exists; push desired configuration. DMS
            //    modifyEndpoint is a full upsert of the connection settings,
            //    so send them all (cheap, no delta computation needed).
            observed = yield* dms
              .modifyEndpoint({
                EndpointArn: observed.EndpointArn!,
                EndpointIdentifier: name,
                EndpointType: news.endpointType,
                EngineName: news.engineName,
                ...buildSettings(news),
              })
              .pipe(Effect.map((r) => r.Endpoint));
          }

          if (!observed?.EndpointArn) {
            return yield* Effect.fail(
              new Error(`DMS endpoint '${name}' has no ARN after reconcile`),
            );
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const arn = observed.EndpointArn;
          const observedTags = yield* readTags(arn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* dms.addTagsToResource({ ResourceArn: arn, Tags: upsert });
          }
          if (removed.length > 0) {
            yield* dms.removeTagsFromResource({
              ResourceArn: arn,
              TagKeys: removed,
            });
          }

          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* dms
            .deleteEndpoint({ EndpointArn: output.endpointArn })
            .pipe(Effect.catchTag("ResourceNotFoundFault", () => Effect.void));
        }),

        list: () =>
          dms.describeEndpoints.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.Endpoints ?? []).filter(
                  (endpoint) =>
                    endpoint.EndpointIdentifier !== undefined &&
                    endpoint.EndpointArn !== undefined,
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach((endpoint) => toAttrs(endpoint), {
                concurrency: 4,
              }),
            ),
          ),
      };
    }),
  );
