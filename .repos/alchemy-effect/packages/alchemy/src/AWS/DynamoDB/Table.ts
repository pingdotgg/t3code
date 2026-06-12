import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type {
  PointInTimeRecoverySpecification,
  TimeToLiveSpecification,
} from "@distilled.cloud/aws/dynamodb";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import type * as lambda from "aws-lambda";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { havePropsChanged, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { Unowned } from "../../AdoptPolicy.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
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

export type TableProps = {
  /**
   * Name of the table. If omitted, Alchemy generates a deterministic physical
   * name from the stack, stage, and logical ID.
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
  pointInTimeRecoverySpecification?: DynamoDB.PointInTimeRecoverySpecification;
  provisionedThroughput?: DynamoDB.ProvisionedThroughput;
  sseSpecification?: DynamoDB.SSESpecification;
  tags?: Record<string, string>;
  timeToLiveSpecification?: DynamoDB.TimeToLiveSpecification;
  warmThroughput?: DynamoDB.WarmThroughput;
  tableClass?: DynamoDB.TableClass;
};

export type TableBinding = {
  streamSpecification?: DynamoDB.StreamSpecification;
};

export interface Table extends Resource<
  "AWS.DynamoDB.Table",
  TableProps,
  {
    tableId: string;
    tableName: TableName;
    tableArn: TableArn;
    partitionKey: string;
    sortKey: string | undefined;
    latestStreamArn: string | undefined;
    streamSpecification: DynamoDB.StreamSpecification | undefined;
    localSecondaryIndexes:
      | DynamoDB.LocalSecondaryIndexDescription[]
      | undefined;
    globalSecondaryIndexes:
      | DynamoDB.GlobalSecondaryIndexDescription[]
      | undefined;
    pointInTimeRecoveryDescription:
      | DynamoDB.PointInTimeRecoveryDescription
      | undefined;
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
 *
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
 * const getItem = yield* DynamoDB.GetItem.bind(table);
 * const putItem = yield* DynamoDB.PutItem.bind(table);
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
 * @section DynamoDB Streams
 * Process change data capture events from a DynamoDB table using a
 * Lambda event source mapping. The stream is enabled automatically
 * through the binding contract.
 *
 * @example Process table changes
 * ```typescript
 * // init
 * yield* DynamoDB.streams(table, {
 *   StreamViewType: "NEW_AND_OLD_IMAGES",
 * }).process(
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
        error._tag === "ResourceNotFoundException";

      const waitForControlPlaneConvergence = Schedule.fixed("1 second").pipe(
        Schedule.both(Schedule.recurs(120)),
      );

      const waitForTableActivationConvergence = Schedule.fixed(
        "10 seconds",
      ).pipe(Schedule.both(Schedule.recurs(180)));

      const waitForGlobalSecondaryIndexesConvergence = Schedule.fixed(
        "10 seconds",
      ).pipe(Schedule.both(Schedule.recurs(180)));

      const waitForDeletionConvergence = Schedule.fixed("1 second").pipe(
        Schedule.both(Schedule.recurs(90)),
      );

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
              schedule: Schedule.exponential(100).pipe(
                Schedule.both(Schedule.recurs(30)),
              ),
            }),
          );

      const updateContinuousBackups = (
        tableName: string,
        pointInTimeRecoverySpecification: PointInTimeRecoverySpecification,
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
              schedule: Schedule.exponential(250).pipe(
                Schedule.both(Schedule.recurs(30)),
              ),
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
              Schedule.tapOutput(([, attempt]) => {
                elapsedSeconds = (attempt + 1) * 10;
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
              Schedule.tapOutput(([, attempt]) => {
                elapsedSeconds = (attempt + 1) * 10;
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
              Schedule.tapOutput(([, attempt]) => {
                elapsedSeconds = attempt + 1;
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
                    Schedule.tapOutput(([, attempt]) => {
                      elapsedSeconds = (attempt + 1) * 10;
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
        error._tag === "LimitExceededException";

      const readTableState = (tableName: string) =>
        Effect.gen(function* () {
          const response = yield* dynamodb
            .describeTable({
              TableName: tableName,
            })
            .pipe(
              Effect.retry({
                while: isRetryableReadError,
                schedule: Schedule.exponential(250).pipe(
                  Schedule.both(Schedule.recurs(30)),
                ),
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
                    schedule: Schedule.exponential(250).pipe(
                      Schedule.both(Schedule.recurs(30)),
                    ),
                  }),
                ),
              dynamodb
                .describeContinuousBackups({
                  TableName: tableName,
                })
                .pipe(
                  Effect.retry({
                    while: (e) => e._tag === "InternalServerError",
                    schedule: Schedule.exponential(250).pipe(
                      Schedule.both(Schedule.recurs(30)),
                    ),
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
                    schedule: Schedule.exponential(250).pipe(
                      Schedule.both(Schedule.recurs(30)),
                    ),
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
          if (
            // TODO(sam): if the name is hard-coded, REPLACE is impossible - we need a suffix
            news.tableName !== olds.tableName ||
            olds.partitionKey !== news.partitionKey ||
            olds.sortKey !== news.sortKey
          ) {
            return { action: "replace" } as const;
          }
          for (const [name, type] of Object.entries(olds.attributes)) {
            if (news.attributes[name] !== type) {
              return { action: "replace" } as const;
            }
          }
          if (
            havePropsChanged(
              { localSecondaryIndexes: olds.localSecondaryIndexes ?? [] },
              { localSecondaryIndexes: news.localSecondaryIndexes ?? [] },
            )
          ) {
            return { action: "replace" } as const;
          }
          const { requiresReplacement } = diffGlobalSecondaryIndexes(
            olds.globalSecondaryIndexes,
            news.globalSecondaryIndexes,
          );
          if (requiresReplacement) {
            return { action: "replace" } as const;
          }
          // TODO(sam):
          // Replacements:
          // 1. if you change ImportSourceSpecification
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
          const observedBillingMode =
            state.table.BillingModeSummary?.BillingMode ?? "PAY_PER_REQUEST";
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
            news.pointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled ??
            false;
          const currentPitrPeriod =
            state.pointInTimeRecoveryDescription?.RecoveryPeriodInDays;
          const desiredPitrPeriod =
            news.pointInTimeRecoverySpecification?.RecoveryPeriodInDays;
          if (
            currentPitrEnabled !== desiredPitrEnabled ||
            (desiredPitrEnabled && currentPitrPeriod !== desiredPitrPeriod)
          ) {
            yield* updateContinuousBackups(tableName, {
              PointInTimeRecoveryEnabled: desiredPitrEnabled,
              RecoveryPeriodInDays: desiredPitrPeriod,
            });
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
                    Schedule.tapOutput(([, attempt]) =>
                      session.note(
                        `DynamoDB Table provider: deleteTable transient failure for ${output.tableName} on attempt ${deleteAttempt} (${formatPollingElapsed(attempt + 1)})`,
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

class ConflictingStreamViewTypes extends Data.TaggedError(
  "ConflictingStreamViewTypes",
)<{
  requested: readonly (DynamoDB.StreamViewType | undefined)[];
}> {}
