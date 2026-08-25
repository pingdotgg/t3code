import type * as lf from "@distilled.cloud/aws/lakeformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetTemporaryGlueTableCredentials}.
 */
export interface GetTemporaryGlueTableCredentialsRequest
  extends lf.GetTemporaryGlueTableCredentialsRequest {}

/**
 * Runtime binding for `lakeformation:GetDataAccess` (table scope).
 *
 * Vends temporary S3 credentials scoped down to the storage of one Glue
 * table, enforcing the caller's Lake Formation grants — the credential
 * vending API used by query engines. The returned `SecretAccessKey` and
 * `SessionToken` are `Redacted`. Provide the implementation with
 * `Effect.provide(AWS.LakeFormation.GetTemporaryGlueTableCredentialsHttp)`.
 * @binding
 * @section Vending Data Access Credentials
 * @example Vend Table-Scoped S3 Credentials
 * ```typescript
 * // init — account-level binding takes no resource
 * const getTableCredentials =
 *   yield* AWS.LakeFormation.GetTemporaryGlueTableCredentials();
 *
 * // runtime
 * const credentials = yield* getTableCredentials({
 *   TableArn: table.tableArn,
 *   Permissions: ["SELECT"],
 *   SupportedPermissionTypes: ["COLUMN_PERMISSION"],
 * });
 * const secret = Redacted.value(credentials.SecretAccessKey!);
 * ```
 */
export interface GetTemporaryGlueTableCredentials extends Binding.Service<
  GetTemporaryGlueTableCredentials,
  "AWS.LakeFormation.GetTemporaryGlueTableCredentials",
  () => Effect.Effect<
    (
      request: GetTemporaryGlueTableCredentialsRequest,
    ) => Effect.Effect<
      lf.GetTemporaryGlueTableCredentialsResponse,
      lf.GetTemporaryGlueTableCredentialsError
    >
  >
> {}

export const GetTemporaryGlueTableCredentials =
  Binding.Service<GetTemporaryGlueTableCredentials>(
    "AWS.LakeFormation.GetTemporaryGlueTableCredentials",
  );
