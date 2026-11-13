import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as s3 from "@distilled.cloud/aws/s3";
import type { StateStoreImpl, StateStoreLifecycle } from "alchemy/Contributions";
import * as Provisioning from "alchemy/State/Provisioning";
import { StateStoreError } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deleteAllObjects } from "../AssetsBucket.ts";
import { AWSEnvironment } from "../Environment.ts";
import {
  createOverflowBucketName,
  createStateTableName,
  dynamoDBState,
  provisionStateTable,
  stateTableExists,
} from "../StateStore/DynamoDBState.ts";
import { provisionStateBucket, stateBucketExists, stateEnvironment } from "../StateStore/State.ts";

/**
 * Ensure a state table and its overflow bucket (by default the account's in
 * this region), with the settings first use would give them.
 */
const bootstrapStateTable = Effect.fn("AWS.state.bootstrap")(function* (name?: string) {
  const { accountId, region } = yield* AWSEnvironment.current;
  if (name !== undefined) yield* Provisioning.storeName(name);
  const tableName = createStateTableName(name);
  const bucketName = createOverflowBucketName(accountId, region, name);
  const existed = yield* stateTableExists(tableName);
  yield* provisionStateTable(tableName);
  // Provisioned ahead too, so a record that overflows mid-deploy in CI
  // does not need to create it.
  yield* provisionStateBucket(bucketName, region);
  return { accountId, region, tableName, existed };
});

/**
 * Delete a state table, lifting its deletion protection, and empty and
 * delete its overflow bucket, every object version included. The S3 store it
 * replaced is kept: `--backend aws-s3` tears that down. A missing table or
 * bucket is not an error.
 */
const teardownStateTable = Effect.fn("AWS.state.teardownTable")(function* (name?: string) {
  const { accountId, region } = yield* AWSEnvironment.current;
  if (name !== undefined) yield* Provisioning.storeName(name);
  const tableName = createStateTableName(name);
  const bucketName = createOverflowBucketName(accountId, region, name);
  const deleted: string[] = [];

  const table = yield* dynamodb.describeTable({ TableName: tableName }).pipe(
    Effect.map((result) => result.Table),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
  if (table !== undefined) {
    if (table.TableStatus !== "DELETING") {
      if (table.DeletionProtectionEnabled) {
        yield* dynamodb.updateTable({ TableName: tableName, DeletionProtectionEnabled: false });
      }
      yield* dynamodb.deleteTable({ TableName: tableName }).pipe(
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        // Still creating or updating.
        Effect.retry({
          while: (error) => error._tag === "ResourceInUseException",
          schedule: Schedule.spaced("2 seconds"),
          times: 30,
        }),
      );
    }
    // Wait for it to go, so a bootstrap straight after creates a fresh one.
    const remains = yield* stateTableExists(tableName).pipe(
      Effect.repeat({
        until: (exists) => !exists,
        schedule: Schedule.spaced("2 seconds"),
        times: 30,
      }),
    );
    if (remains) {
      return yield* new StateStoreError({
        message: `DynamoDB state table '${tableName}' is still deleting`,
      });
    }
    deleted.push(tableName);
  }

  if (yield* stateBucketExists(bucketName)) {
    yield* deleteAllObjects(bucketName);
    yield* s3.deleteBucket({ Bucket: bucketName }).pipe(
      Effect.catchTag("NoSuchBucket", () => Effect.void),
      Effect.retry({
        while: (error) => error._tag === "OperationAborted" || error._tag === "ServiceUnavailable",
        schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(10)]),
      }),
    );
    deleted.push(bucketName);
  }
  return { deleted };
});

/** The AWS environment of the profile core runs the operation under. */
const environment = stateEnvironment();

/**
 * The DynamoDB state store's lifecycle, for `Alchemist.State` and
 * `alchemy state`. The store also creates its table on first use, so
 * bootstrapping is only needed to provision it ahead of time.
 */
export const lifecycle: StateStoreLifecycle = {
  bootstrap: ({ name }) =>
    bootstrapStateTable(name).pipe(
      Effect.map(({ tableName, accountId, region, existed }) => ({
        status: existed ? ("adopted" as const) : ("created" as const),
        store: tableName,
        location: { account: accountId, region },
      })),
      Effect.provide(environment),
    ),
  teardown: ({ name }) => teardownStateTable(name).pipe(Effect.provide(environment)),
};

/** The state store AWS contributes, as `--backend aws`. */
export const stateStore: StateStoreImpl = {
  layer: (options) => dynamoDBState(options),
  lifecycle,
};
