import { dynamoDBState, type DynamoDBStateOptions } from "./DynamoDBState.ts";
import { s3State, type S3StateOptions } from "./State.ts";

export interface StateOptions extends DynamoDBStateOptions {
  /**
   * The store to keep state in. `"dynamodb"` keeps it in a DynamoDB table;
   * `"s3"` keeps it in the S3 bucket earlier versions used. Passing
   * {@link StateOptions.bucketName}, {@link StateOptions.prefix} or
   * {@link StateOptions.encryption} without a backend selects `"s3"`.
   *
   * @default "dynamodb"
   */
  backend?: "dynamodb" | "s3";
  /** With the S3 store: see {@link S3StateOptions.bucketName}. */
  bucketName?: S3StateOptions["bucketName"];
  /** With the S3 store: see {@link S3StateOptions.prefix}. */
  prefix?: S3StateOptions["prefix"];
  /** With the S3 store: see {@link S3StateOptions.encryption}. */
  encryption?: S3StateOptions["encryption"];
}

/** Options only the S3 store takes. A config that sets one keeps using it. */
const usesS3 = (options: StateOptions) =>
  options.backend === "s3" ||
  (options.backend === undefined &&
    (options.bucketName !== undefined ||
      options.prefix !== undefined ||
      options.encryption !== undefined));

/**
 * The AWS state store: one DynamoDB table per account and region,
 * `alchemy-state`.
 *
 * A deploy loads a stage's state with one query and writes each change as
 * it happens. Records too large for a DynamoDB item go to an S3 overflow
 * bucket. Concurrent deploys of a stage fail fast on its lease instead of
 * mixing writes.
 *
 * The table is created on first use, except in CI, where `alchemy state
 * bootstrap --backend aws` provisions it ahead.
 *
 * ### Using the State Store
 * **Example:** Default table
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "@alchemy.run/aws";
 *
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   { providers: AWS.providers(), state: AWS.state() },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * **Example:** A separate, named store
 * ```typescript
 * const stateStore = AWS.state({ name: "team-a" }); // table alchemy-state-team-a
 * ```
 *
 * ### Migrating from the S3 State Store
 * Earlier versions kept state in an S3 bucket,
 * `alchemy-state-<accountId>-<region>-an`. A stage still there is refused
 * until it is moved. In the project, so the store the entrypoint
 * configures is the one migrated:
 *
 * ```sh
 * alchemy state migrate --profile <your-profile>
 * ```
 *
 * The command moves every stage, or those `--stack` and `--stage` select.
 * The bucket policy closes each moved stage's S3 objects, so every older
 * alchemy fails at its first read instead of deploying from the old copy;
 * the objects are kept. A stage another deploy holds is reported and
 * skipped: run the command again once it finishes. `--rollback`, run with
 * the same version, moves stages back to S3 before going back to an older
 * one.
 *
 * ### Keeping State in S3
 * **Example:** The S3 store
 * ```typescript
 * const stateStore = AWS.state({ backend: "s3" });
 * ```
 *
 * **Example:** A custom bucket, prefix and KMS key
 * ```typescript
 * const stateStore = AWS.state({
 *   bucketName: "my-company-state-123456789012-us-east-1-an",
 *   prefix: "alchemy",
 *   encryption: { sseAlgorithm: "aws:kms", kmsMasterKeyId: "alias/alchemy-state" },
 * });
 * ```
 *
 * ### Supplying the AWS Environment
 * The store resolves its account, region and credentials from the configured
 * profile, CI credentials or the ambient AWS environment. Provide an
 * `AWSEnvironment` to use another credential source, and the same layer to
 * `AWS.providers()`.
 *
 * **Example:** Deploy-role credentials shared with the providers
 * ```typescript
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: AWS.providers().pipe(Layer.provide(environment)),
 *     state: AWS.state().pipe(Layer.provide(environment)),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * @resource
 */
export const state = (options: StateOptions = {}) =>
  usesS3(options) ? s3State(options) : dynamoDBState(options);
