import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type { TimeToLiveSpecification } from "@distilled.cloud/aws/dynamodb";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import type * as lambda from "aws-lambda";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { havePropsChanged, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type TableName = string;

export type TableArn =
  `arn:aws:dynamodb:${RegionID}:${AccountID}:table/${TableName}`;

export type TableRecord<Data> = Omit<lambda.DynamoDBRecord, "dynamodb"> & {
  dynamodb: Omit<lambda.StreamRecord, "NewImage" | "OldImage"> & {
    NewImage?: Data;
    OldImage?: Data;
  };
};

export type TableEvent<Data> = Omit<lambda.DynamoDBStreamEvent, "Records"> & {
  Records: TableRecord<Data>[];
};

export type ScalarAttributeType = "S" | "N" | "B";

export interface PointInTimeRecoverySpecification {
  /**
   * Whether point-in-time recovery (continuous backups) is enabled for the
   * table.
   */
  pointInTimeRecoveryEnabled: boolean;
  /**
   * How far back the table can be restored, e.g. `"7 days"` or
   * `Duration.days(7)`. Rounded to whole days on the wire (1–35 days).
   * @default 35 days
   */
  recoveryPeriod?: Duration.Input;
}

export interface KinesisStreamingDestination {
  /**
   * ARN of the destination Kinesis Data Stream. The stream must be ACTIVE
   * when the destination is enabled (deploy the `AWS.Kinesis.Stream`
   * resource in the same stack and pass `stream.streamArn`).
   */
  streamArn: string;
  /**
   * Precision of the approximate creation timestamp stamped on records
   * delivered to the Kinesis stream. Changing this on an ACTIVE destination
   * updates it in place, but the UPDATING→ACTIVE transition can take several
   * minutes.
   * @default "MILLISECOND"
   */
  approximateCreationDateTimePrecision?: DynamoDB.ApproximateCreationDateTimePrecision;
}

export type TableProps = {
  /**
   * Name of the table. If omitted, Alchemy generates a deterministic physical
   * name from the stack, stage, and logical ID, suffixed with the instance ID
   * so replacements can create the successor table before deleting the old one.
   *
   * Changing this property replaces the table. If the name is hard-coded,
   * replacement-triggering changes (key schema, attribute types, LSIs, GSI
   * key changes) delete the old table first and then recreate it under the
   * same name, since DynamoDB table names are unique per account/region.
   */
  tableName?: string;
  /**
   * Partition key attribute name for the table.
   */
  partitionKey: string;
  /**
   * Optional sort key attribute name for the table.
   */
  sortKey?: string;
  /**
   * Attribute definitions used by the primary key and any secondary indexes.
   */
  attributes: Record<string, ScalarAttributeType>;
  localSecondaryIndexes?: DynamoDB.LocalSecondaryIndex[];
  globalSecondaryIndexes?: DynamoDB.GlobalSecondaryIndex[];
  billingMode?: DynamoDB.BillingMode;
  deletionProtectionEnabled?: boolean;
  onDemandThroughput?: DynamoDB.OnDemandThroughput;
  /**
   * Enables point-in-time recovery (continuous backups) and optionally sets
   * the recovery window via `recoveryPeriod` (a `Duration.Input`, rounded to
   * whole days on the wire).
   */
  pointInTimeRecoverySpecification?: PointInTimeRecoverySpecification;
  provisionedThroughput?: DynamoDB.ProvisionedThroughput;
  sseSpecification?: DynamoDB.SSESpecification;
  tags?: Record<string, string>;
  timeToLiveSpecification?: DynamoDB.TimeToLiveSpecification;
  warmThroughput?: DynamoDB.WarmThroughput;
  tableClass?: DynamoDB.TableClass;
  /**
   * Resource-based IAM policy document (JSON string) attached to the table.
   * Grants cross-account or scoped-principal access to the table and its
   * indexes. Removing the property deletes the policy.
   */
  resourcePolicy?: string;
  /**
   * Streams change data capture records to the given Kinesis Data Stream.
   * Changing the stream disables the old destination before enabling the
   * new one; removing the property disables streaming.
   */
  kinesisStreamingDestination?: KinesisStreamingDestination;
  /**
   * Enables CloudWatch Contributor Insights (table-level rule) for the
   * table, surfacing the most-accessed and most-throttled keys.
   * @default false
   */
  contributorInsightsEnabled?: boolean;
};

export type TableBinding = {
  streamSpecification?: DynamoDB.StreamSpecification;
};

export interface Table extends Resource<
  "AWS.DynamoDB.Table",
  TableProps,
  {
    /** The unique ID AWS assigns to the table. */
    tableId: string;
    /** The physical name of the table. */
    tableName: TableName;
    /** The ARN of the table. */
    tableArn: TableArn;
    /** The partition (hash) key attribute name. */
    partitionKey: string;
    /** The sort (range) key attribute name, if defined. */
    sortKey: string | undefined;
    /** ARN of the most recent DynamoDB stream (when streams are enabled). */
    latestStreamArn: string | undefined;
    /** The current stream configuration (when streams are enabled). */
    streamSpecification: DynamoDB.StreamSpecification | undefined;
    /** Descriptions of the table's local secondary indexes. */
    localSecondaryIndexes:
      | DynamoDB.LocalSecondaryIndexDescription[]
      | undefined;
    /** Descriptions of the table's global secondary indexes. */
    globalSecondaryIndexes:
      | DynamoDB.GlobalSecondaryIndexDescription[]
      | undefined;
    /** The point-in-time recovery status of the table. */
    pointInTimeRecoveryDescription:
      | DynamoDB.PointInTimeRecoveryDescription
      | undefined;
    /** The tags attached to the table. */
    tags: Record<string, string> | undefined;
  },
  TableBinding,
  Providers
> {}

/**
 * An Amazon DynamoDB table with optional indexes, PITR, TTL, and stream-aware
 * binding support.
 *
 * `Table` owns the lifecycle of the physical table while the binding contract
 * allows runtime-specific integrations such as Lambda table event sources to
 * request stream configuration without forcing a circular input prop.
 * @resource
 * @section Creating Tables
 * @example Basic Table
 * ```typescript
 * import * as DynamoDB from "alchemy/AWS/DynamoDB";
 *
 * const table = yield* DynamoDB.Table("UsersTable", {
 *   partitionKey: "pk",
 *   attributes: {
 *     pk: "S",
 *   },
 * });
 * ```
 *
 * @example Table with Sort Key and TTL
 * ```typescript
 * const table = yield* DynamoDB.Table("SessionsTable", {
 *   partitionKey: "userId",
 *   sortKey: "sessionId",
 *   attributes: {
 *     userId: "S",
 *     sessionId: "S",
 *     expiresAt: "N",
 *   },
 *   timeToLiveSpecification: {
 *     Enabled: true,
 *     AttributeName: "expiresAt",
 *   },
 * });
 * ```
 *
 * @example Table with Global Secondary Index
 * ```typescript
 * const table = yield* DynamoDB.Table("OrdersTable", {
 *   partitionKey: "pk",
 *   sortKey: "sk",
 *   attributes: {
 *     pk: "S",
 *     sk: "S",
 *     gsi1pk: "S",
 *     gsi1sk: "S",
 *   },
 *   globalSecondaryIndexes: [{
 *     IndexName: "GSI1",
 *     KeySchema: [
 *       { AttributeName: "gsi1pk", KeyType: "HASH" },
 *       { AttributeName: "gsi1sk", KeyType: "RANGE" },
 *     ],
 *     Projection: { ProjectionType: "ALL" },
 *   }],
 * });
 * ```
 *
 * @section Runtime Operations
 * Bind DynamoDB operations in the init phase and use them in runtime
 * handlers. Bindings inject the table name and grant scoped IAM
 * permissions automatically.
 *
 * @example Read and write items
 * ```typescript
 * // init
 * const getItem = yield* AWS.DynamoDB.GetItem(table);
 * const putItem = yield* AWS.DynamoDB.PutItem(table);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* putItem({
 *       Item: { pk: { S: "user#123" }, name: { S: "Alice" } },
 *     });
 *     const result = yield* getItem({
 *       Key: { pk: { S: "user#123" } },
 *     });
 *     return yield* HttpServerResponse.json(result.Item);
 *   }),
 * };
 * ```
 *
 * @section Table Features
 * @example Resource Policy
 * ```typescript
 * const table = yield* DynamoDB.Table("SharedTable", {
 *   partitionKey: "pk",
 *   attributes: { pk: "S" },
 *   resourcePolicy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { AWS: "arn:aws:iam::111122223333:root" },
 *       Action: ["dynamodb:GetItem", "dynamodb:Query"],
 *       Resource: "*",
 *     }],
 *   }),
 * });
 * ```
 *
 * @example Kinesis Streaming Destination
 * ```typescript
 * import * as Kinesis from "alchemy/AWS/Kinesis";
 *
 * const stream = yield* Kinesis.Stream("CdcStream", {});
 * const table = yield* DynamoDB.Table("CdcTable", {
 *   partitionKey: "pk",
 *   attributes: { pk: "S" },
 *   kinesisStreamingDestination: {
 *     streamArn: stream.streamArn,
 *     approximateCreationDateTimePrecision: "MICROSECOND",
 *   },
 * });
 * ```
 *
 * @example Contributor Insights
 * ```typescript
 * const table = yield* DynamoDB.Table("HotKeyTable", {
 *   partitionKey: "pk",
 *   attributes: { pk: "S" },
 *   contributorInsightsEnabled: true,
 * });
 * ```
 *
 * @section DynamoDB Streams
 * Process change data capture events from a DynamoDB table using a
 * Lambda event source mapping. The stream is enabled automatically
 * through the binding contract.
 *
 * @example Process table changes
 * ```typescript
 * // init
 * yield* DynamoDB.consumeTableChanges(
 *   table,
 *   { streamViewType: "NEW_AND_OLD_IMAGES" },
 *   Effect.fn(function* (record) {
 *     yield* Effect.log(`${record.eventName}: ${JSON.stringify(record.dynamodb)}`);
 *   }),
 * );
 * ```
 */
export const Table = Resource<Table>("AWS.DynamoDB.Table");

export const TableProvider = () =>
  Provider.effect(
    Table,
    Effect.gen(function* () {
      const createTableName = (
        id: string,
        props: Input.ResolveProps<TableProps>,
      ) =>
        Effect.gen(function* () {
          return (
            props.tableName ??
            (yield* createPhysicalName({
              id,
              // see: https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TableDescription.html#DDB-Type-TableDescription-TableName
              maxLength: 255,
            }))
          );
        });

      const toKeySchema = (props: Input.ResolveProps<TableProps>) => [
        {
          AttributeName: props.partitionKey,
          KeyType: "HASH" as const,
        },
        ...(props.sortKey
          ? [
              {
                AttributeName: props.sortKey,
                KeyType: "RANGE" as const,
              },
            ]
          : []),
      ];

      const toAttributeDefinitions = (
        attrs: Record<string, ScalarAttributeType>,
      ) =>
        Object.entries(attrs)
          .map(([name, type]) => ({
            AttributeName: name,
            AttributeType: type,
          }))
          .sort((a, b) => a.AttributeName.localeCompare(b.AttributeName));

      const adoptExistingTable = (tableName: string) =>
        // The engine has cleared us via `read` (foreign-tagged tables are
        // surfaced as `Unowned`). On a race between read and create, just
        // describe the existing table and continue.
        dynamodb
          .describeTable({ TableName: tableName })
          .pipe(Effect.map((r) => r.Table!));

      const createTags = Effect.fn(function* (
        id: string,
        tags?: Record<string, string>,
      ) {
        return {
          ...(yield* createInternalTags(id)),
          ...tags,
        };
      });

      const normalizeStreamSpecification = (
        streamSpecification: DynamoDB.StreamSpecification | undefined,
      ) =>
        streamSpecification?.StreamEnabled === true
          ? ({
              StreamEnabled: true,
              StreamViewType: streamSpecification.StreamViewType,
            } satisfies DynamoDB.StreamSpecification)
          : undefined;

      const resolveStreamSpecification = (
        bindings: ReadonlyArray<TableBinding | { data?: TableBinding }>,
      ) =>
        Effect.gen(function* () {
          const requested = bindings
            .flatMap((binding) =>
              (binding as { data?: TableBinding }).data?.streamSpecification
                ?.StreamEnabled === true
                ? [
                    normalizeStreamSpecification(
                      (binding as { data?: TableBinding }).data
                        ?.streamSpecification,
                    ),
                  ]
                : (binding as TableBinding).streamSpecification
                      ?.StreamEnabled === true
                  ? [
                      normalizeStreamSpecification(
                        (binding as TableBinding).streamSpecification,
                      ),
                    ]
                  : [],
            )
            .filter((spec) => spec !== undefined);

          if (requested.length === 0) {
            return undefined;
          }

          const [first, ...rest] = requested;
          if (!first?.StreamViewType) {
            return yield* Effect.fail(new MissingStreamViewType());
          }

          for (const spec of rest) {
            if (spec.StreamViewType !== first.StreamViewType) {
              return yield* Effect.fail(
                new ConflictingStreamViewTypes({
                  requested: requested.map((item) => item.StreamViewType),
                }),
              );
            }
          }

          return first;
        });

      const isRetryableControlPlaneError = (error: { _tag?: string }) =>
        error._tag === "InternalServerError" ||
        error._tag === "LimitExceededException" ||
        error._tag === "ResourceInUseException" ||
        error._tag === "ResourceNotFoundException" ||
        // Throttling: DynamoDB's control-plane API limits are low and the
        // blanket SDK retry (10 attempts) is easily exhausted when the whole
        // suite hammers create/update/describe concurrently. Give it the
        // provider's much larger budget too.
        error._tag === "ThrottlingException" ||
        error._tag === "ProvisionedThroughputExceededException" ||
        error._tag === "RequestLimitExceeded";

      const waitForControlPlaneConvergence = Schedule.max([
        Schedule.fixed("1 second"),
        Schedule.recurs(120),
      ]);

      const waitForTableActivationConvergence = Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(180),
      ]);

      const waitForGlobalSecondaryIndexesConvergence = Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(180),
      ]);

      const waitForDeletionConvergence = Schedule.max([
        Schedule.fixed("1 second"),
        Schedule.recurs(90),
      ]);

      const formatPollingElapsed = (elapsedSeconds: number) =>
        `${elapsedSeconds}s elapsed`;

      const formatGlobalSecondaryIndexStatuses = (
        indexes:
          | readonly DynamoDB.GlobalSecondaryIndexDescription[]
          | undefined,
      ) =>
        JSON.stringify(
          (indexes ?? []).map((index) => ({
            name: index.IndexName,
            status: index.IndexStatus,
            backfilling: index.Backfilling,
          })),
        );

      const updateTimeToLive = (
        tableName: string,
        timeToLiveSpecification: TimeToLiveSpecification,
      ) =>
        dynamodb
          .updateTimeToLive({
            TableName: tableName,
            TimeToLiveSpecification: timeToLiveSpecification!,
          })
          .pipe(
            Effect.retry({
              while: isRetryableControlPlaneError,
              schedule: Schedule.max([
                Schedule.exponential(100),
                Schedule.recurs(30),
              ]),
            }),
          );

      const updateContinuousBackups = (
        tableName: string,
        pointInTimeRecoverySpecification: DynamoDB.PointInTimeRecoverySpecification,
      ) =>
        dynamodb
          .updateContinuousBackups({
            TableName: tableName,
            PointInTimeRecoverySpecification: pointInTimeRecoverySpecification,
          })
          .pipe(
            Effect.retry({
              while: (e) =>
                e._tag === "ContinuousBackupsUnavailableException" ||
                isRetryableControlPlaneError(e),
              schedule: Schedule.max([
                Schedule.exponential(250),
                Schedule.recurs(30),
              ]),
            }),
          );

      // Resource policies are compared as canonicalized JSON so formatting
      // differences between what the user wrote and what AWS stores don't
      // cause phantom putResourcePolicy calls on every reconcile.
      const canonicalPolicyDocument = (policy: string | undefined) => {
        if (policy === undefined) return undefined;
        try {
          return JSON.stringify(JSON.parse(policy));
        } catch {
          return policy;
        }
      };

      const readTableResourcePolicy = (tableArn: string) =>
        dynamodb.getResourcePolicy({ ResourceArn: tableArn }).pipe(
          Effect.map((response) => response.Policy),
          Effect.catchTag("PolicyNotFoundException", () =>
            Effect.succeed(undefined),
          ),
          Effect.retry({
            while: isRetryableControlPlaneError,
            schedule: Schedule.max([
              Schedule.exponential(250),
              Schedule.recurs(15),
            ]),
          }),
        );

      const putTableResourcePolicy = (tableArn: string, policy: string) =>
        dynamodb
          .putResourcePolicy({ ResourceArn: tableArn, Policy: policy })
          .pipe(
            Effect.retry({
              while: isRetryableControlPlaneError,
              schedule: Schedule.max([
                Schedule.exponential(250),
                Schedule.recurs(15),
              ]),
            }),
          );

      const deleteTableResourcePolicy = (tableArn: string) =>
        dynamodb.deleteResourcePolicy({ ResourceArn: tableArn }).pipe(
          Effect.catchTag("PolicyNotFoundException", () => Effect.void),
          Effect.retry({
            while: isRetryableControlPlaneError,
            schedule: Schedule.max([
              Schedule.exponential(250),
              Schedule.recurs(15),
            ]),
          }),
        );

      const isKinesisDestinationTransitioning = (
        destination: DynamoDB.KinesisDataStreamDestination,
      ) =>
        destination.DestinationStatus === "ENABLING" ||
        destination.DestinationStatus === "DISABLING" ||
        destination.DestinationStatus === "UPDATING";

      // Kinesis streaming destinations transition ENABLING→ACTIVE and
      // DISABLING→DISABLED within seconds, but a precision change
      // (UPDATING→ACTIVE) takes multiple minutes; poll bounded to 8 minutes.
      const waitForKinesisDestinationsConvergence = Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(96),
      ]);

      const waitForKinesisDestinationsSettled = (
        session: {
          note: (message: string) => Effect.Effect<void, never, never>;
        },
        tableName: string,
      ) => {
        let elapsedSeconds = 0;
        return Effect.gen(function* () {
          const response = yield* dynamodb.describeKinesisStreamingDestination({
            TableName: tableName,
          });
          const destinations = response.KinesisDataStreamDestinations ?? [];
          if (destinations.some(isKinesisDestinationTransitioning)) {
            return yield* Effect.fail(new KinesisDestinationNotSettled());
          }
          return destinations;
        }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "KinesisDestinationNotSettled" ||
              isRetryableControlPlaneError(error),
            schedule: waitForKinesisDestinationsConvergence.pipe(
              Schedule.tap(({ attempt }) => {
                elapsedSeconds = (attempt + 1) * 5;
                return session.note(
                  `DynamoDB Table provider: waiting for Kinesis streaming destinations on ${tableName} to settle (${formatPollingElapsed(elapsedSeconds)})`,
                );
              }),
            ),
          }),
        );
      };

      const disableKinesisDestination = (
        tableName: string,
        streamArn: string,
      ) =>
        dynamodb
          .disableKinesisStreamingDestination({
            TableName: tableName,
            StreamArn: streamArn,
          })
          .pipe(
            Effect.retry({
              while: isRetryableControlPlaneError,
              schedule: Schedule.max([
                Schedule.exponential(250),
                Schedule.recurs(15),
              ]),
            }),
          );

      const enableKinesisDestination = (
        tableName: string,
        destination: KinesisStreamingDestination,
      ) =>
        dynamodb
          .enableKinesisStreamingDestination({
            TableName: tableName,
            StreamArn: destination.streamArn,
            EnableKinesisStreamingConfiguration:
              destination.approximateCreationDateTimePrecision !== undefined
                ? {
                    ApproximateCreationDateTimePrecision:
                      destination.approximateCreationDateTimePrecision,
                  }
                : undefined,
          })
          .pipe(
            Effect.retry({
              while: isRetryableControlPlaneError,
              schedule: Schedule.max([
                Schedule.exponential(250),
                Schedule.recurs(15),
              ]),
            }),
          );

      const updateKinesisDestinationPrecision = (
        tableName: string,
        destination: KinesisStreamingDestination,
      ) =>
        dynamodb
          .updateKinesisStreamingDestination({
            TableName: tableName,
            StreamArn: destination.streamArn,
            UpdateKinesisStreamingConfiguration: {
              ApproximateCreationDateTimePrecision:
                destination.approximateCreationDateTimePrecision,
            },
          })
          .pipe(
            Effect.retry({
              while: isRetryableControlPlaneError,
              schedule: Schedule.max([
                Schedule.exponential(250),
                Schedule.recurs(15),
              ]),
            }),
          );

      // Contributor Insights transitions ENABLING→ENABLED / DISABLING→DISABLED
      // within seconds, but UpdateContributorInsights rejects a DISABLE while
      // the status is still ENABLING — wait for a settled status before
      // diffing observed against desired.
      const waitForContributorInsightsSettled = (
        session: {
          note: (message: string) => Effect.Effect<void, never, never>;
        },
        tableName: string,
      ) =>
        Effect.gen(function* () {
          const response = yield* dynamodb.describeContributorInsights({
            TableName: tableName,
          });
          const status = response.ContributorInsightsStatus ?? "DISABLED";
          if (status === "ENABLING" || status === "DISABLING") {
            return yield* Effect.fail(new ContributorInsightsNotSettled());
          }
          return status;
        }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "ContributorInsightsNotSettled" ||
              isRetryableControlPlaneError(error),
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(45),
            ]).pipe(
              Schedule.tap(({ attempt }) =>
                session.note(
                  `DynamoDB Table provider: waiting for Contributor Insights on ${tableName} to settle (${formatPollingElapsed((attempt + 1) * 2)})`,
                ),
              ),
            ),
          }),
        );

      // Enabling Contributor Insights makes DynamoDB create CloudWatch rules
      // named `DynamoDBContributorInsights-{PKC|PKT}-<tableName>-<timestamp>`
      // in the customer's account. Those rules can ONLY be removed by
      // DynamoDB's own asynchronous cleanup, which runs when an
      // UpdateContributorInsights DISABLE completes — CloudWatch's
      // DeleteInsightRules/PutInsightRule reject them with AccessDenied even
      // for account admins, and deleting the table aborts the cleanup and
      // strands the rules forever (recoverable only via AWS support). The
      // delete lifecycle therefore observes the rules and holds off
      // deleteTable until DynamoDB's cleanup has actually removed them.
      const listContributorInsightsRules = (tableName: string) =>
        cloudwatch.describeInsightRules.pages({}).pipe(
          Stream.runFold(
            () => [] as string[],
            (acc, page) => [
              ...acc,
              ...(page.InsightRules ?? [])
                .map((rule) => rule.Name)
                .filter(
                  (name): name is string =>
                    name !== undefined &&
                    name.startsWith("DynamoDBContributorInsights-") &&
                    name.includes(`-${tableName}-`),
                ),
            ],
          ),
        );

      const waitForContributorInsightsRulesDeleted = (
        session: {
          note: (message: string) => Effect.Effect<void, never, never>;
        },
        tableName: string,
      ) =>
        Effect.gen(function* () {
          const remaining = yield* listContributorInsightsRules(tableName);
          if (remaining.length > 0) {
            return yield* Effect.fail(new ContributorInsightsNotSettled());
          }
        }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "ContributorInsightsNotSettled" ||
              isRetryableControlPlaneError(error),
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(20),
            ]).pipe(
              Schedule.tap(({ attempt }) =>
                session.note(
                  `DynamoDB Table provider: waiting for Contributor Insights rules of ${tableName} to be cleaned up (${formatPollingElapsed((attempt + 1) * 2)})`,
                ),
              ),
            ),
          }),
          // Rules from a PREVIOUS enable session whose cleanup was already
          // aborted (e.g. by an out-of-band table deletion) can never be
          // removed by anyone but AWS support — don't wedge the delete on
          // them; surface a note and move on.
          Effect.catchTag("ContributorInsightsNotSettled", () =>
            session.note(
              `DynamoDB Table provider: Contributor Insights rules for ${tableName} were not cleaned up by DynamoDB; they may be stranded from an earlier enable session (deletable only via AWS support)`,
            ),
          ),
        );

      const updateTableContributorInsights = (
        tableName: string,
        enabled: boolean,
      ) =>
        dynamodb
          .updateContributorInsights({
            TableName: tableName,
            ContributorInsightsAction: enabled ? "ENABLE" : "DISABLE",
          })
          .pipe(
            Effect.retry({
              while: isRetryableControlPlaneError,
              schedule: Schedule.max([
                Schedule.exponential(250),
                Schedule.recurs(15),
              ]),
            }),
          );

      const waitForTableActive = (
        session: {
          note: (message: string) => Effect.Effect<void, never, never>;
        },
        tableName: string,
      ) => {
        let elapsedSeconds = 0;
        let progressMessage = `DynamoDB Table provider: waiting for table ${tableName} to become ACTIVE`;

        return Effect.gen(function* () {
          const response = yield* dynamodb.describeTable({
            TableName: tableName,
          });
          if (response.Table?.TableStatus !== "ACTIVE") {
            progressMessage = `DynamoDB Table provider: table ${tableName} not active yet (status=${response.Table?.TableStatus ?? "undefined"} gsiStatuses=${formatGlobalSecondaryIndexStatuses(response.Table?.GlobalSecondaryIndexes)})`;
            return yield* Effect.fail(new TableNotActive());
          }
          yield* session.note(
            `DynamoDB Table provider: table ${tableName} is ACTIVE (${formatPollingElapsed(elapsedSeconds)})`,
          );
          return response.Table;
        }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "TableNotActive" ||
              isRetryableControlPlaneError(error),
            schedule: waitForTableActivationConvergence.pipe(
              Schedule.tap(({ attempt }) => {
                elapsedSeconds = attempt * 10;
                return session.note(
                  `${progressMessage} (${formatPollingElapsed(elapsedSeconds)})`,
                );
              }),
            ),
          }),
        );
      };

      const waitForGlobalSecondaryIndexesStable = (
        session: {
          note: (message: string) => Effect.Effect<void, never, never>;
        },
        tableName: string,
        expectedIndexNames: readonly string[],
      ) => {
        let elapsedSeconds = 0;
        let progressMessage = `DynamoDB Table provider: waiting for GSIs on ${tableName} to stabilize`;

        return Effect.gen(function* () {
          const response = yield* dynamodb.describeTable({
            TableName: tableName,
          });
          const table = response.Table;
          const actualIndexNames = [...(table?.GlobalSecondaryIndexes ?? [])]
            .map((index) => index.IndexName!)
            .sort();
          const expected = [...expectedIndexNames].sort();
          const allActive = (table?.GlobalSecondaryIndexes ?? []).every(
            (index) => index.IndexStatus === "ACTIVE",
          );

          if (
            JSON.stringify(actualIndexNames) !== JSON.stringify(expected) ||
            !allActive
          ) {
            progressMessage = `DynamoDB Table provider: GSIs for ${tableName} not stable yet (expected=${JSON.stringify(expected)} actual=${JSON.stringify(actualIndexNames)} statuses=${JSON.stringify((table?.GlobalSecondaryIndexes ?? []).map((index) => ({ name: index.IndexName, status: index.IndexStatus })))} tableStatus=${table?.TableStatus ?? "undefined"})`;
            return yield* Effect.fail(new TableIndexesNotStable());
          }

          yield* session.note(
            `DynamoDB Table provider: GSIs for ${tableName} stabilized (${JSON.stringify(actualIndexNames)}) (${formatPollingElapsed(elapsedSeconds)})`,
          );
          return table;
        }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "TableIndexesNotStable" ||
              isRetryableControlPlaneError(error),
            schedule: waitForGlobalSecondaryIndexesConvergence.pipe(
              Schedule.tap(({ attempt }) => {
                elapsedSeconds = attempt * 10;
                return session.note(
                  `${progressMessage} (${formatPollingElapsed(elapsedSeconds)})`,
                );
              }),
            ),
          }),
        );
      };

      const waitForTableDeleted = (
        session: {
          note: (message: string) => Effect.Effect<void, never, never>;
        },
        tableName: string,
      ) => {
        let elapsedSeconds = 0;
        let progressMessage = `DynamoDB Table provider: waiting for deletion of ${tableName}`;

        return Effect.gen(function* () {
          const response = yield* dynamodb.describeTable({
            TableName: tableName,
          });
          progressMessage = `DynamoDB Table provider: table ${tableName} still deleting (status=${response.Table?.TableStatus ?? "undefined"})`;
          return yield* Effect.fail(new TableStillDeleting());
        }).pipe(
          Effect.catchTag("ResourceNotFoundException", () => {
            return session.note(
              `DynamoDB Table provider: table ${tableName} deletion confirmed (${formatPollingElapsed(elapsedSeconds)})`,
            );
          }),
          Effect.retry({
            while: (error) =>
              error._tag === "TableStillDeleting" ||
              isRetryableControlPlaneError(error),
            schedule: waitForDeletionConvergence.pipe(
              Schedule.tap(({ attempt }) => {
                elapsedSeconds = attempt;
                return session.note(
                  `${progressMessage} (${formatPollingElapsed(elapsedSeconds)})`,
                );
              }),
            ),
          }),
        );
      };

      const deleteGlobalSecondaryIndexes = (
        session: {
          note: (message: string) => Effect.Effect<void, never, never>;
        },
        tableName: string,
      ) =>
        Effect.gen(function* () {
          const response = yield* dynamodb
            .describeTable({
              TableName: tableName,
            })
            .pipe(
              Effect.retry({
                while: isRetryableControlPlaneError,
                schedule: waitForControlPlaneConvergence,
              }),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({ Table: undefined }),
              ),
            );

          const indexNames = [...(response.Table?.GlobalSecondaryIndexes ?? [])]
            .map((index) => index.IndexName!)
            .sort();

          if (indexNames.length === 0) {
            yield* session.note(
              `DynamoDB Table provider: no GSIs remain on ${tableName}; retrying table deletion`,
            );
            return;
          }

          yield* session.note(
            `DynamoDB Table provider: deleting GSIs before deleting table ${tableName} (${indexNames.join(", ")})`,
          );

          yield* waitForGlobalSecondaryIndexesStable(
            session,
            tableName,
            indexNames,
          );

          const remainingIndexNames = [...indexNames];
          for (const indexName of indexNames) {
            let elapsedSeconds = 0;
            let progressMessage = `DynamoDB Table provider: waiting to delete GSI ${indexName} from ${tableName}`;

            yield* session.note(
              `DynamoDB Table provider: deleting GSI ${indexName} from ${tableName}`,
            );

            yield* dynamodb
              .updateTable({
                TableName: tableName,
                GlobalSecondaryIndexUpdates: [
                  {
                    Delete: {
                      IndexName: indexName,
                    },
                  },
                ],
              })
              .pipe(
                Effect.timeout(1000),
                Effect.tap(() =>
                  session.note(
                    `DynamoDB Table provider: delete accepted for GSI ${indexName} on ${tableName} (${formatPollingElapsed(elapsedSeconds)})`,
                  ),
                ),
                Effect.retry({
                  while: (error) => {
                    if (error._tag === "ResourceInUseException") {
                      progressMessage = `DynamoDB Table provider: delete for GSI ${indexName} on ${tableName} is blocked while the table or indexes are still transitioning`;
                      return true;
                    }
                    if (error._tag === "TimeoutError") {
                      progressMessage = `DynamoDB Table provider: delete for GSI ${indexName} on ${tableName} timed out`;
                      return true;
                    }
                    if (
                      error._tag === "InternalServerError" ||
                      error._tag === "LimitExceededException"
                    ) {
                      progressMessage = `DynamoDB Table provider: delete for GSI ${indexName} on ${tableName} hit ${error._tag}`;
                      return true;
                    }
                    return false;
                  },
                  schedule: waitForGlobalSecondaryIndexesConvergence.pipe(
                    Schedule.tap(({ attempt }) => {
                      elapsedSeconds = attempt * 10;
                      return session.note(
                        `${progressMessage} (${formatPollingElapsed(elapsedSeconds)})`,
                      );
                    }),
                  ),
                }),
              );

            remainingIndexNames.splice(
              remainingIndexNames.indexOf(indexName),
              1,
            );

            yield* waitForGlobalSecondaryIndexesStable(
              session,
              tableName,
              remainingIndexNames,
            );
          }
        });

      // For read, we want `ResourceNotFoundException` to propagate immediately
      // (the table doesn't exist — this is the cold-start adoption "no
      // resource" signal). Only retry on transient control-plane errors.
      const isRetryableReadError = (error: { _tag?: string }) =>
        error._tag === "InternalServerError" ||
        error._tag === "LimitExceededException" ||
        // See `isRetryableControlPlaneError`: read-path describes throttle too
        // under full-suite concurrency, so ride them out generously.
        error._tag === "ThrottlingException" ||
        error._tag === "ProvisionedThroughputExceededException" ||
        error._tag === "RequestLimitExceeded";

      const readTableState = (tableName: string) =>
        Effect.gen(function* () {
          const response = yield* dynamodb
            .describeTable({
              TableName: tableName,
            })
            .pipe(
              Effect.retry({
                while: isRetryableReadError,
                schedule: Schedule.max([
                  Schedule.exponential(250),
                  Schedule.recurs(30),
                ]),
              }),
            );
          const table = response.Table;
          if (!table?.TableArn) {
            return yield* Effect.fail(
              new Error(`Table ${tableName} not found`),
            );
          }

          const [tagsResult, continuousBackupsResult, ttlResult] =
            yield* Effect.all([
              dynamodb
                .listTagsOfResource({
                  ResourceArn: table.TableArn,
                })
                .pipe(
                  Effect.retry({
                    while: isRetryableReadError,
                    schedule: Schedule.max([
                      Schedule.exponential(250),
                      Schedule.recurs(30),
                    ]),
                  }),
                ),
              dynamodb
                .describeContinuousBackups({
                  TableName: tableName,
                })
                .pipe(
                  Effect.retry({
                    while: (e) => e._tag === "InternalServerError",
                    schedule: Schedule.max([
                      Schedule.exponential(250),
                      Schedule.recurs(30),
                    ]),
                  }),
                  Effect.catchTag("TableNotFoundException", () =>
                    Effect.succeed({ ContinuousBackupsDescription: undefined }),
                  ),
                ),
              dynamodb
                .describeTimeToLive({
                  TableName: tableName,
                })
                .pipe(
                  Effect.retry({
                    while: isRetryableReadError,
                    schedule: Schedule.max([
                      Schedule.exponential(250),
                      Schedule.recurs(30),
                    ]),
                  }),
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed({ TimeToLiveDescription: undefined }),
                  ),
                ),
            ]);

          return {
            table,
            tags: Object.fromEntries(
              (tagsResult.Tags ?? []).map((tag) => [tag.Key!, tag.Value!]),
            ) as Record<string, string>,
            pointInTimeRecoveryDescription:
              continuousBackupsResult.ContinuousBackupsDescription
                ?.PointInTimeRecoveryDescription,
            timeToLiveDescription: ttlResult.TimeToLiveDescription,
          };
        }).pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      const toAttrs = (state: {
        table: DynamoDB.TableDescription;
        tags: Record<string, string>;
        pointInTimeRecoveryDescription:
          | DynamoDB.PointInTimeRecoveryDescription
          | undefined;
      }) => ({
        tableId: state.table.TableId!,
        tableName: state.table.TableName!,
        tableArn: state.table.TableArn! as TableArn,
        partitionKey:
          state.table.KeySchema?.find((key) => key.KeyType === "HASH")
            ?.AttributeName ?? "",
        sortKey: state.table.KeySchema?.find((key) => key.KeyType === "RANGE")
          ?.AttributeName,
        latestStreamArn: state.table.LatestStreamArn,
        streamSpecification: state.table.StreamSpecification,
        localSecondaryIndexes: state.table.LocalSecondaryIndexes,
        globalSecondaryIndexes: state.table.GlobalSecondaryIndexes,
        pointInTimeRecoveryDescription: state.pointInTimeRecoveryDescription,
        tags: state.tags,
      });

      const indexesByName = <T extends { IndexName?: string }>(
        indexes: readonly T[] | undefined,
      ) =>
        Object.fromEntries(
          (indexes ?? []).map((index) => [index.IndexName!, index]),
        ) as Record<string, T>;

      const sortKeySchema = (
        keySchema: readonly DynamoDB.KeySchemaElement[] | undefined,
      ) =>
        [...(keySchema ?? [])].sort((a, b) =>
          `${a.KeyType}:${a.AttributeName}`.localeCompare(
            `${b.KeyType}:${b.AttributeName}`,
          ),
        );

      const normalizeProjection = (
        projection: DynamoDB.Projection | undefined,
      ) => ({
        ...projection,
        NonKeyAttributes: [...(projection?.NonKeyAttributes ?? [])].sort(),
      });

      const isSameGsiDefinition = (
        left: DynamoDB.GlobalSecondaryIndex,
        right: DynamoDB.GlobalSecondaryIndex,
      ) =>
        JSON.stringify(sortKeySchema(left.KeySchema)) ===
          JSON.stringify(sortKeySchema(right.KeySchema)) &&
        JSON.stringify(normalizeProjection(left.Projection)) ===
          JSON.stringify(normalizeProjection(right.Projection));

      // The describe response includes server-side bookkeeping fields
      // (`NumberOfDecreasesToday`, `LastIncreaseDateTime`, etc.) that the
      // request shape doesn't. For PAY_PER_REQUEST tables it also reports
      // a zero-throughput object. Normalize both sides to the user-settable
      // fields so we don't fire a phantom UpdateGlobalSecondaryIndex with
      // `ProvisionedThroughput: undefined` (which AWS rejects with
      // ValidationException).
      const normalizeProvisioned = (
        pt:
          | { ReadCapacityUnits?: number; WriteCapacityUnits?: number }
          | undefined,
      ) => {
        if (
          !pt ||
          ((pt.ReadCapacityUnits ?? 0) === 0 &&
            (pt.WriteCapacityUnits ?? 0) === 0)
        ) {
          return undefined;
        }
        return {
          ReadCapacityUnits: pt.ReadCapacityUnits,
          WriteCapacityUnits: pt.WriteCapacityUnits,
        };
      };

      const normalizeOnDemand = (
        od:
          | {
              MaxReadRequestUnits?: number;
              MaxWriteRequestUnits?: number;
            }
          | undefined,
      ) => {
        if (
          !od ||
          ((od.MaxReadRequestUnits ?? -1) < 0 &&
            (od.MaxWriteRequestUnits ?? -1) < 0)
        ) {
          return undefined;
        }
        return {
          MaxReadRequestUnits: od.MaxReadRequestUnits,
          MaxWriteRequestUnits: od.MaxWriteRequestUnits,
        };
      };

      const normalizeWarm = (
        wt:
          | { ReadUnitsPerSecond?: number; WriteUnitsPerSecond?: number }
          | undefined,
      ) => {
        if (
          !wt ||
          ((wt.ReadUnitsPerSecond ?? 0) === 0 &&
            (wt.WriteUnitsPerSecond ?? 0) === 0)
        ) {
          return undefined;
        }
        return {
          ReadUnitsPerSecond: wt.ReadUnitsPerSecond,
          WriteUnitsPerSecond: wt.WriteUnitsPerSecond,
        };
      };

      const diffGlobalSecondaryIndexes = (
        olds: readonly DynamoDB.GlobalSecondaryIndex[] | undefined,
        news: readonly DynamoDB.GlobalSecondaryIndex[] | undefined,
      ) => {
        const oldByName = indexesByName(olds);
        const newByName = indexesByName(news);
        const updates: DynamoDB.GlobalSecondaryIndexUpdate[] = [];
        let requiresReplacement = false;

        for (const [indexName, oldIndex] of Object.entries(oldByName)) {
          const newIndex = newByName[indexName];
          if (!newIndex) {
            updates.push({
              Delete: {
                IndexName: indexName,
              },
            });
            continue;
          }

          if (!isSameGsiDefinition(oldIndex, newIndex)) {
            requiresReplacement = true;
            continue;
          }

          // Only emit an Update when the user has explicitly set a
          // throughput value AND it differs from observed. Cloud-side
          // defaults (AWS auto-assigns ProvisionedThroughput/WarmThroughput
          // values for PAY_PER_REQUEST tables) should not trigger phantom
          // updates against an undefined desired value.
          const provDiff =
            newIndex.ProvisionedThroughput !== undefined &&
            JSON.stringify(
              normalizeProvisioned(oldIndex.ProvisionedThroughput),
            ) !==
              JSON.stringify(
                normalizeProvisioned(newIndex.ProvisionedThroughput),
              );
          const odDiff =
            newIndex.OnDemandThroughput !== undefined &&
            JSON.stringify(normalizeOnDemand(oldIndex.OnDemandThroughput)) !==
              JSON.stringify(normalizeOnDemand(newIndex.OnDemandThroughput));
          const wtDiff =
            newIndex.WarmThroughput !== undefined &&
            JSON.stringify(normalizeWarm(oldIndex.WarmThroughput)) !==
              JSON.stringify(normalizeWarm(newIndex.WarmThroughput));
          if (provDiff || odDiff || wtDiff) {
            updates.push({
              Update: {
                IndexName: indexName,
                ProvisionedThroughput: newIndex.ProvisionedThroughput,
                OnDemandThroughput: newIndex.OnDemandThroughput,
                WarmThroughput: newIndex.WarmThroughput,
              },
            });
          }
        }

        for (const [indexName, newIndex] of Object.entries(newByName)) {
          if (!oldByName[indexName]) {
            updates.push({
              Create: {
                IndexName: indexName,
                KeySchema: newIndex.KeySchema,
                Projection: newIndex.Projection,
                ProvisionedThroughput: newIndex.ProvisionedThroughput,
                OnDemandThroughput: newIndex.OnDemandThroughput,
                WarmThroughput: newIndex.WarmThroughput,
              },
            });
          }
        }

        return {
          updates,
          requiresReplacement,
        };
      };

      return Table.Provider.of({
        stables: ["tableName", "tableId", "tableArn"],
        // Enumerate every table in the ambient account/region. `listTables`
        // returns only names, so each is hydrated to the full Attributes shape
        // via the same multi-API read helper (`readTableState`) `read` uses.
        list: () =>
          Effect.gen(function* () {
            const names = yield* dynamodb.listTables.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            const states = yield* Effect.forEach(
              names,
              (tableName) =>
                readTableState(tableName).pipe(
                  // Hydrating every table fires four describe calls each.
                  // Across a busy account this trips DynamoDB's read throttle,
                  // and a table that isn't ACTIVE yet (a peer mid-create)
                  // transiently rejects the continuous-backups/TTL describes
                  // with ValidationException. Both are transient — retry to
                  // converge so a table that *is* ours still hydrates fully.
                  Effect.retry({
                    while: (e) =>
                      e._tag === "ThrottlingException" ||
                      e._tag === "ValidationException",
                    schedule: Schedule.max([
                      Schedule.exponential(250).pipe(Schedule.jittered),
                      Schedule.recurs(12),
                    ]),
                  }),
                  // Last resort: if a foreign table never settles within the
                  // retry budget (e.g. a peer is still mid-create/delete when
                  // we give up), skip it rather than failing the whole
                  // enumeration. Our own table is ACTIVE by the time list()
                  // runs, so it always hydrates via the retry above.
                  Effect.catchTag("ValidationException", () =>
                    Effect.succeed(undefined),
                  ),
                ),
              { concurrency: 8 },
            );
            return states
              .filter((state) => state !== undefined)
              .map((state) => toAttrs(state));
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const tableName =
            output?.tableName ??
            (olds ? yield* createTableName(id, olds) : undefined);
          if (!tableName) return undefined;
          const state = yield* readTableState(tableName).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          if (!state) return undefined;
          const attrs = toAttrs(state);
          return (yield* hasAlchemyTags(id, state.tags as any))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // Renaming the table always replaces. The successor's name cannot
          // collide with the predecessor's, so the default
          // create-before-delete replacement flow applies.
          if (news.tableName !== olds.tableName) {
            return { action: "replace" } as const;
          }
          // For every other replacement trigger the physical name stays the
          // same. Engine-generated names embed the instance id, which is
          // re-minted on replacement, so the successor gets a fresh name and
          // create-before-delete works. A hard-coded `tableName` cannot
          // change — DynamoDB table names are unique per account/region, so
          // the successor's createTable would collide with the still-live
          // predecessor and mis-adopt it. Delete the old generation first in
          // that case; `delete` waits until the name is fully released.
          const replace =
            news.tableName !== undefined
              ? ({ action: "replace", deleteFirst: true } as const)
              : ({ action: "replace" } as const);
          if (
            olds.partitionKey !== news.partitionKey ||
            olds.sortKey !== news.sortKey
          ) {
            return replace;
          }
          for (const [name, type] of Object.entries(olds.attributes ?? {})) {
            if (news.attributes[name] !== type) {
              return replace;
            }
          }
          if (
            havePropsChanged(
              { localSecondaryIndexes: olds.localSecondaryIndexes ?? [] },
              { localSecondaryIndexes: news.localSecondaryIndexes ?? [] },
            )
          ) {
            return replace;
          }
          const { requiresReplacement } = diffGlobalSecondaryIndexes(
            olds.globalSecondaryIndexes,
            news.globalSecondaryIndexes,
          );
          if (requiresReplacement) {
            return replace;
          }
          // ImportSourceSpecification (importTable) is out of scope — see
          // processes/AWS/catalog/serverless-data.md (import/export are
          // long-running jobs, deferred as effectful functions).
        }),

        reconcile: Effect.fn(function* ({
          id,
          output,
          news,
          session,
          bindings,
        }) {
          const tableName =
            output?.tableName ?? (yield* createTableName(id, news));
          const desiredTags = yield* createTags(id, news.tags);
          const desiredStreamSpecification =
            yield* resolveStreamSpecification(bindings);

          // Observe cloud state. `output` is treated as a cache for the table
          // name; the table's actual existence and configuration are fetched
          // fresh so the reconciler converges regardless of drift, adoption,
          // or a partially-completed prior run.
          let state = yield* readTableState(tableName);

          if (state === undefined) {
            yield* session.note(
              `Table ${tableName}: creating with stream specification ${JSON.stringify(desiredStreamSpecification)}`,
            );
            yield* dynamodb
              .createTable({
                TableName: tableName,
                TableClass: news.tableClass,
                KeySchema: toKeySchema(news),
                AttributeDefinitions: toAttributeDefinitions(news.attributes),
                LocalSecondaryIndexes: news.localSecondaryIndexes,
                GlobalSecondaryIndexes: news.globalSecondaryIndexes,
                BillingMode: news.billingMode ?? "PAY_PER_REQUEST",
                SSESpecification: news.sseSpecification,
                StreamSpecification: desiredStreamSpecification,
                WarmThroughput: news.warmThroughput,
                DeletionProtectionEnabled: news.deletionProtectionEnabled,
                OnDemandThroughput: news.onDemandThroughput,
                ProvisionedThroughput: news.provisionedThroughput,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.retry({
                  while: (e) =>
                    e._tag === "LimitExceededException" ||
                    e._tag === "InternalServerError",
                  schedule: Schedule.exponential(100),
                }),
                // A peer reconciler created the table between our observe and
                // create; describe it and continue with the sync path.
                Effect.catchTag("ResourceInUseException", () =>
                  adoptExistingTable(tableName),
                ),
              );

            yield* waitForTableActive(session, tableName);

            if ((news.globalSecondaryIndexes?.length ?? 0) > 0) {
              yield* waitForGlobalSecondaryIndexesStable(
                session,
                tableName,
                news.globalSecondaryIndexes?.map((index) => index.IndexName) ??
                  [],
              );
            }

            state = yield* readTableState(tableName);
            if (!state) {
              return yield* Effect.fail(
                new Error(`Failed to read created table ${tableName}`),
              );
            }
          }

          // Sync stream specification — observed ↔ desired.
          //
          // SQL of stream changes: changing the StreamViewType requires a
          // disable→enable sequence; AWS rejects an in-place view-type change.
          const currentStreamSpecification = normalizeStreamSpecification(
            state.table.StreamSpecification,
          );
          const streamViewTypeChanged =
            currentStreamSpecification?.StreamEnabled === true &&
            desiredStreamSpecification?.StreamEnabled === true &&
            currentStreamSpecification.StreamViewType !==
              desiredStreamSpecification.StreamViewType;

          if (streamViewTypeChanged) {
            yield* dynamodb.updateTable({
              TableName: tableName,
              StreamSpecification: { StreamEnabled: false },
            });
            yield* waitForTableActive(session, tableName);
          }

          if (
            havePropsChanged(
              { streamSpecification: currentStreamSpecification },
              { streamSpecification: desiredStreamSpecification },
            )
          ) {
            yield* session.note(
              `Table ${tableName}: updating stream configuration`,
            );
            yield* dynamodb.updateTable({
              TableName: tableName,
              StreamSpecification: desiredStreamSpecification ?? {
                StreamEnabled: false,
              },
            });
            yield* waitForTableActive(session, tableName);
          }

          // Sync GSIs — diff observed cloud state against desired and apply
          // each delta serially. AWS only accepts one GSI change per
          // updateTable call. The diff function only reads fields shared
          // between `GlobalSecondaryIndex` and `GlobalSecondaryIndexDescription`
          // (IndexName, KeySchema, Projection, throughputs), so the cast is safe.
          const { updates: globalSecondaryIndexUpdates } =
            diffGlobalSecondaryIndexes(
              state.table.GlobalSecondaryIndexes as
                | readonly DynamoDB.GlobalSecondaryIndex[]
                | undefined,
              news.globalSecondaryIndexes,
            );

          for (const globalSecondaryIndexUpdate of globalSecondaryIndexUpdates) {
            const action = globalSecondaryIndexUpdate.Create
              ? `create ${globalSecondaryIndexUpdate.Create.IndexName}`
              : globalSecondaryIndexUpdate.Update
                ? `update ${globalSecondaryIndexUpdate.Update.IndexName}`
                : `delete ${globalSecondaryIndexUpdate.Delete!.IndexName}`;
            yield* session.note(
              `Table ${tableName}: applying GSI update (${action})`,
            );
            yield* dynamodb.updateTable({
              TableName: tableName,
              AttributeDefinitions: toAttributeDefinitions(news.attributes),
              GlobalSecondaryIndexUpdates: [globalSecondaryIndexUpdate],
            });
            yield* waitForTableActive(session, tableName);
          }

          if (globalSecondaryIndexUpdates.length > 0) {
            const expectedNames =
              news.globalSecondaryIndexes?.map((index) => index.IndexName) ??
              [];
            yield* session.note(
              `Table ${tableName}: waiting for GSIs to stabilize (${expectedNames.join(", ") || "none"})`,
            );
            yield* waitForGlobalSecondaryIndexesStable(
              session,
              tableName,
              expectedNames,
            );
            yield* session.note(`Table ${tableName}: GSIs stabilized`);
          }

          // Sync base attributes — observed ↔ desired.
          const desiredBillingMode = news.billingMode ?? "PAY_PER_REQUEST";
          // DynamoDB omits `BillingModeSummary` for tables that have always
          // been PROVISIONED — fall back to the observed throughput (on-demand
          // tables report 0 read capacity) so an unchanged PROVISIONED table
          // does not trigger a spurious `updateTable` (which DynamoDB rejects
          // with "provisioned throughput will not change").
          const observedBillingMode =
            state.table.BillingModeSummary?.BillingMode ??
            ((state.table.ProvisionedThroughput?.ReadCapacityUnits ?? 0) > 0
              ? "PROVISIONED"
              : "PAY_PER_REQUEST");
          const observedProvisionedThroughput = state.table
            .ProvisionedThroughput
            ? {
                ReadCapacityUnits:
                  state.table.ProvisionedThroughput.ReadCapacityUnits,
                WriteCapacityUnits:
                  state.table.ProvisionedThroughput.WriteCapacityUnits,
              }
            : undefined;
          const baseChanged = havePropsChanged(
            {
              tableClass: state.table.TableClassSummary?.TableClass,
              billingMode: observedBillingMode,
              deletionProtectionEnabled:
                state.table.DeletionProtectionEnabled ?? false,
              provisionedThroughput:
                desiredBillingMode === "PROVISIONED"
                  ? observedProvisionedThroughput
                  : undefined,
            },
            {
              tableClass: news.tableClass,
              billingMode: desiredBillingMode,
              deletionProtectionEnabled:
                news.deletionProtectionEnabled ?? false,
              provisionedThroughput:
                desiredBillingMode === "PROVISIONED"
                  ? news.provisionedThroughput
                  : undefined,
            },
          );

          if (baseChanged) {
            yield* dynamodb.updateTable({
              TableName: tableName,
              TableClass: news.tableClass,
              AttributeDefinitions: toAttributeDefinitions(news.attributes),
              BillingMode: desiredBillingMode,
              SSESpecification: news.sseSpecification,
              WarmThroughput: news.warmThroughput,
              DeletionProtectionEnabled: news.deletionProtectionEnabled,
              OnDemandThroughput: news.onDemandThroughput,
              ProvisionedThroughput: news.provisionedThroughput,
            });
            yield* waitForTableActive(session, tableName);
          }

          // Sync TTL — observed ↔ desired.
          //
          // updateTimeToLive rejects calls that would not change anything
          // (e.g. enabling TTL on the same attribute name), so we have to
          // diff against the current TimeToLiveDescription before calling.
          const currentTtl = state.timeToLiveDescription;
          const currentTtlEnabled =
            currentTtl?.TimeToLiveStatus === "ENABLED" ||
            currentTtl?.TimeToLiveStatus === "ENABLING";
          const currentTtlAttribute = currentTtl?.AttributeName;
          const desiredTtl = news.timeToLiveSpecification;
          const desiredTtlEnabled = desiredTtl?.Enabled === true;
          const desiredTtlAttribute = desiredTtl?.AttributeName;

          if (
            desiredTtlEnabled !== currentTtlEnabled ||
            (desiredTtlEnabled && desiredTtlAttribute !== currentTtlAttribute)
          ) {
            if (desiredTtlEnabled) {
              if (
                currentTtlEnabled &&
                currentTtlAttribute !== desiredTtlAttribute
              ) {
                // AWS only allows one TTL attribute. We must disable first
                // before re-enabling on a different attribute.
                yield* updateTimeToLive(tableName, {
                  AttributeName: currentTtlAttribute!,
                  Enabled: false,
                });
              }
              yield* updateTimeToLive(tableName, {
                AttributeName: desiredTtlAttribute!,
                Enabled: true,
              });
            } else if (currentTtlEnabled && currentTtlAttribute) {
              yield* updateTimeToLive(tableName, {
                AttributeName: currentTtlAttribute,
                Enabled: false,
              });
            }
          }

          // Sync PITR — observed ↔ desired.
          const currentPitrEnabled =
            state.pointInTimeRecoveryDescription?.PointInTimeRecoveryStatus ===
            "ENABLED";
          const desiredPitrEnabled =
            news.pointInTimeRecoverySpecification?.pointInTimeRecoveryEnabled ??
            false;
          const currentPitrPeriod =
            state.pointInTimeRecoveryDescription?.RecoveryPeriodInDays;
          const desiredPitrPeriod = toWireDays(
            news.pointInTimeRecoverySpecification?.recoveryPeriod,
          );
          if (
            currentPitrEnabled !== desiredPitrEnabled ||
            (desiredPitrEnabled && currentPitrPeriod !== desiredPitrPeriod)
          ) {
            yield* updateContinuousBackups(tableName, {
              PointInTimeRecoveryEnabled: desiredPitrEnabled,
              RecoveryPeriodInDays: desiredPitrPeriod,
            });
          }

          // Sync resource policy — observed ↔ desired. The observed policy is
          // read fresh from the cloud (never olds/output) so adoption and
          // out-of-band drift converge.
          const observedPolicy = yield* readTableResourcePolicy(
            state.table.TableArn!,
          );
          if (
            canonicalPolicyDocument(observedPolicy) !==
            canonicalPolicyDocument(news.resourcePolicy)
          ) {
            if (news.resourcePolicy !== undefined) {
              yield* session.note(
                `Table ${tableName}: putting resource policy`,
              );
              yield* putTableResourcePolicy(
                state.table.TableArn!,
                news.resourcePolicy,
              );
            } else {
              yield* session.note(
                `Table ${tableName}: deleting resource policy`,
              );
              yield* deleteTableResourcePolicy(state.table.TableArn!);
            }
          }

          // Sync Kinesis streaming destination — observe the table's actual
          // destinations, wait out any in-flight transition (enable/disable
          // reject while another change is in progress), disable whatever is
          // ACTIVE but not desired, then enable/update the desired
          // destination and wait for it to reach ACTIVE.
          const desiredKinesisDestination = news.kinesisStreamingDestination;
          let kinesisDestinations = yield* waitForKinesisDestinationsSettled(
            session,
            tableName,
          );
          for (const destination of kinesisDestinations) {
            if (destination.DestinationStatus !== "ACTIVE") continue;
            if (
              destination.StreamArn === desiredKinesisDestination?.streamArn
            ) {
              continue;
            }
            yield* session.note(
              `Table ${tableName}: disabling Kinesis streaming destination ${destination.StreamArn}`,
            );
            yield* disableKinesisDestination(tableName, destination.StreamArn!);
            kinesisDestinations = yield* waitForKinesisDestinationsSettled(
              session,
              tableName,
            );
          }
          if (desiredKinesisDestination !== undefined) {
            const activeDestination = kinesisDestinations.find(
              (destination) =>
                destination.StreamArn === desiredKinesisDestination.streamArn &&
                destination.DestinationStatus === "ACTIVE",
            );
            if (activeDestination === undefined) {
              yield* session.note(
                `Table ${tableName}: enabling Kinesis streaming destination ${desiredKinesisDestination.streamArn}`,
              );
              yield* enableKinesisDestination(
                tableName,
                desiredKinesisDestination,
              );
              kinesisDestinations = yield* waitForKinesisDestinationsSettled(
                session,
                tableName,
              );
            } else if (
              desiredKinesisDestination.approximateCreationDateTimePrecision !==
                undefined &&
              (activeDestination.ApproximateCreationDateTimePrecision ??
                "MILLISECOND") !==
                desiredKinesisDestination.approximateCreationDateTimePrecision
            ) {
              yield* session.note(
                `Table ${tableName}: updating Kinesis streaming destination precision to ${desiredKinesisDestination.approximateCreationDateTimePrecision}`,
              );
              yield* updateKinesisDestinationPrecision(
                tableName,
                desiredKinesisDestination,
              );
              kinesisDestinations = yield* waitForKinesisDestinationsSettled(
                session,
                tableName,
              );
            }
            const settledDestination = kinesisDestinations.find(
              (destination) =>
                destination.StreamArn === desiredKinesisDestination.streamArn,
            );
            if (settledDestination?.DestinationStatus !== "ACTIVE") {
              return yield* Effect.fail(
                new KinesisStreamingDestinationFailed({
                  tableName,
                  streamArn: desiredKinesisDestination.streamArn,
                  status: settledDestination?.DestinationStatus,
                  description: settledDestination?.DestinationStatusDescription,
                }),
              );
            }
          }

          // Sync Contributor Insights — observed ↔ desired.
          const desiredInsightsEnabled =
            news.contributorInsightsEnabled ?? false;
          const observedInsightsStatus =
            yield* waitForContributorInsightsSettled(session, tableName);
          const observedInsightsEnabled = observedInsightsStatus === "ENABLED";
          if (observedInsightsEnabled !== desiredInsightsEnabled) {
            yield* session.note(
              `Table ${tableName}: ${desiredInsightsEnabled ? "enabling" : "disabling"} Contributor Insights`,
            );
            yield* updateTableContributorInsights(
              tableName,
              desiredInsightsEnabled,
            );
            if (!desiredInsightsEnabled) {
              // Wait for the DISABLE to settle so DynamoDB's rule cleanup
              // (which fires on the DISABLING→DISABLED transition) runs
              // while the table still exists — a deleteTable racing this
              // window strands the CloudWatch rules forever.
              yield* waitForContributorInsightsSettled(session, tableName);
            }
          }

          // Sync tags — diff observed cloud tags against desired.
          //
          // Adoption may bring us a table that already has its own tag set;
          // diffing against `state.tags` (fetched fresh) lets the reconciler
          // converge ownership without fighting whatever was there before.
          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (removed.length > 0) {
            yield* dynamodb.untagResource({
              ResourceArn: state.table.TableArn!,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* dynamodb.tagResource({
              ResourceArn: state.table.TableArn!,
              Tags: upsert,
            });
          }

          // Re-read final state after all sync steps so the returned
          // attributes reflect the post-reconcile cloud state.
          const final = yield* readTableState(tableName);
          if (!final) {
            return yield* Effect.fail(
              new Error(`Failed to read reconciled table ${tableName}`),
            );
          }

          yield* session.note(final.table.TableArn!);

          return {
            ...toAttrs(final),
            tags: desiredTags,
          };
        }),

        delete: Effect.fn(function* ({ output, session }) {
          // Contributor Insights must be fully torn down BEFORE the table is
          // deleted: DynamoDB removes its CloudWatch insight rules only when
          // a DISABLE completes while the table exists. Deleting the table
          // while insights are ENABLED (or mid-transition) aborts that
          // cleanup and strands the rules — CloudWatch rejects direct
          // deletion of DynamoDB-managed rules with AccessDenied, so only
          // AWS support can remove them afterwards.
          yield* Effect.gen(function* () {
            const insightsStatus = yield* waitForContributorInsightsSettled(
              session,
              output.tableName,
            );
            if (insightsStatus !== "DISABLED") {
              yield* session.note(
                `Table ${output.tableName}: disabling Contributor Insights before delete`,
              );
              yield* updateTableContributorInsights(output.tableName, false);
              yield* waitForContributorInsightsSettled(
                session,
                output.tableName,
              );
            }
            yield* waitForContributorInsightsRulesDeleted(
              session,
              output.tableName,
            );
          }).pipe(
            // Table already gone — nothing to tear down.
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );

          let deleteAttempt = 0;

          while (true) {
            deleteAttempt += 1;
            yield* session.note(
              `Table ${output.tableName}: deleting (attempt ${deleteAttempt})`,
            );

            const deleteResult = yield* dynamodb
              .deleteTable({
                TableName: output.tableName,
              })
              .pipe(
                Effect.timeout(1000),
                Effect.as("accepted" as const),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed("already-deleted" as const),
                ),
                Effect.catchTag("ResourceInUseException", () =>
                  Effect.succeed("delete-gsis-first" as const),
                ),
                Effect.retry({
                  while: (error) =>
                    error._tag === "InternalServerError" ||
                    error._tag === "TimeoutError",
                  schedule: waitForDeletionConvergence.pipe(
                    Schedule.tap(({ attempt }) =>
                      session.note(
                        `DynamoDB Table provider: deleteTable transient failure for ${output.tableName} on attempt ${deleteAttempt} (${formatPollingElapsed(attempt)})`,
                      ),
                    ),
                  ),
                }),
              );

            if (deleteResult === "accepted") {
              yield* session.note(
                `DynamoDB Table provider: deleteTable accepted for ${output.tableName}`,
              );
              break;
            }

            if (deleteResult === "already-deleted") {
              yield* session.note(
                `DynamoDB Table provider: table ${output.tableName} already deleted`,
              );
              return;
            }

            yield* session.note(
              `DynamoDB Table provider: deleteTable blocked for ${output.tableName}; deleting GSIs first`,
            );
            yield* deleteGlobalSecondaryIndexes(session, output.tableName);
            yield* waitForGlobalSecondaryIndexesStable(
              session,
              output.tableName,
              [],
            );
            yield* waitForTableActive(session, output.tableName);
          }

          yield* session.note(
            `Table ${output.tableName}: waiting for deletion`,
          );
          yield* waitForTableDeleted(session, output.tableName);
        }),
      });
    }),
  );

class TableNotActive extends Data.TaggedError("TableNotActive") {}

class TableIndexesNotStable extends Data.TaggedError("TableIndexesNotStable") {}

class TableStillDeleting extends Data.TaggedError("TableStillDeleting") {}

class MissingStreamViewType extends Data.TaggedError("MissingStreamViewType") {}

class KinesisDestinationNotSettled extends Data.TaggedError(
  "KinesisDestinationNotSettled",
) {}

class ContributorInsightsNotSettled extends Data.TaggedError(
  "ContributorInsightsNotSettled",
) {}

class KinesisStreamingDestinationFailed extends Data.TaggedError(
  "KinesisStreamingDestinationFailed",
)<{
  tableName: string;
  streamArn: string;
  status: string | undefined;
  description: string | undefined;
}> {}

class ConflictingStreamViewTypes extends Data.TaggedError(
  "ConflictingStreamViewTypes",
)<{
  requested: readonly (DynamoDB.StreamViewType | undefined)[];
}> {}
