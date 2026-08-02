import type * as lf from "@distilled.cloud/aws/lakeformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetTemporaryDataLocationCredentials}.
 */
export interface GetTemporaryDataLocationCredentialsRequest
  extends lf.GetTemporaryDataLocationCredentialsRequest {}

/**
 * Runtime binding for `lakeformation:GetDataAccess` (data-location scope).
 *
 * Vends temporary S3 credentials for registered data locations the caller
 * holds `DATA_LOCATION_ACCESS` on. The returned credentials'
 * `SecretAccessKey` and `SessionToken` are `Redacted`. Provide the
 * implementation with
 * `Effect.provide(AWS.LakeFormation.GetTemporaryDataLocationCredentialsHttp)`.
 * @binding
 * @section Vending Data Access Credentials
 * @example Vend Location-Scoped S3 Credentials
 * ```typescript
 * // init — account-level binding takes no resource
 * const getLocationCredentials =
 *   yield* AWS.LakeFormation.GetTemporaryDataLocationCredentials();
 *
 * // runtime
 * const { Credentials } = yield* getLocationCredentials({
 *   DataLocations: [location.resourceArn],
 *   CredentialsScope: "READ",
 * });
 * ```
 */
export interface GetTemporaryDataLocationCredentials extends Binding.Service<
  GetTemporaryDataLocationCredentials,
  "AWS.LakeFormation.GetTemporaryDataLocationCredentials",
  () => Effect.Effect<
    (
      request: GetTemporaryDataLocationCredentialsRequest,
    ) => Effect.Effect<
      lf.GetTemporaryDataLocationCredentialsResponse,
      lf.GetTemporaryDataLocationCredentialsError
    >
  >
> {}

export const GetTemporaryDataLocationCredentials =
  Binding.Service<GetTemporaryDataLocationCredentials>(
    "AWS.LakeFormation.GetTemporaryDataLocationCredentials",
  );
