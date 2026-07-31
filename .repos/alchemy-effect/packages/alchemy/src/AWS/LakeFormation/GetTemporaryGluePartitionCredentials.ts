import type * as lf from "@distilled.cloud/aws/lakeformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetTemporaryGluePartitionCredentials}.
 */
export interface GetTemporaryGluePartitionCredentialsRequest
  extends lf.GetTemporaryGluePartitionCredentialsRequest {}

/**
 * Runtime binding for `lakeformation:GetDataAccess` (partition scope).
 *
 * Identical to {@link GetTemporaryGlueTableCredentials} but scoped down to a
 * single partition's S3 prefix. The returned `SecretAccessKey` and
 * `SessionToken` are `Redacted`. Provide the implementation with
 * `Effect.provide(AWS.LakeFormation.GetTemporaryGluePartitionCredentialsHttp)`.
 * @binding
 * @section Vending Data Access Credentials
 * @example Vend Partition-Scoped S3 Credentials
 * ```typescript
 * // init — account-level binding takes no resource
 * const getPartitionCredentials =
 *   yield* AWS.LakeFormation.GetTemporaryGluePartitionCredentials();
 *
 * // runtime
 * const credentials = yield* getPartitionCredentials({
 *   TableArn: table.tableArn,
 *   Partition: { Values: ["2026-07-14"] },
 *   Permissions: ["SELECT"],
 * });
 * ```
 */
export interface GetTemporaryGluePartitionCredentials extends Binding.Service<
  GetTemporaryGluePartitionCredentials,
  "AWS.LakeFormation.GetTemporaryGluePartitionCredentials",
  () => Effect.Effect<
    (
      request: GetTemporaryGluePartitionCredentialsRequest,
    ) => Effect.Effect<
      lf.GetTemporaryGluePartitionCredentialsResponse,
      lf.GetTemporaryGluePartitionCredentialsError
    >
  >
> {}

export const GetTemporaryGluePartitionCredentials =
  Binding.Service<GetTemporaryGluePartitionCredentials>(
    "AWS.LakeFormation.GetTemporaryGluePartitionCredentials",
  );
