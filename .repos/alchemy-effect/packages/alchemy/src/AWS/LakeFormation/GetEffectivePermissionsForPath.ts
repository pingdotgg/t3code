import type * as lf from "@distilled.cloud/aws/lakeformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetEffectivePermissionsForPath}.
 */
export interface GetEffectivePermissionsForPathRequest
  extends lf.GetEffectivePermissionsForPathRequest {}

/**
 * Runtime binding for `lakeformation:GetEffectivePermissionsForPath`.
 *
 * Returns the Lake Formation permissions in effect for the databases and
 * tables stored under a registered S3 path — an authorization audit for a
 * data location. Provide the implementation with
 * `Effect.provide(AWS.LakeFormation.GetEffectivePermissionsForPathHttp)`.
 * @binding
 * @section Auditing Permissions
 * @example Audit Permissions on a Registered Location
 * ```typescript
 * // init — account-level binding takes no resource
 * const getEffectivePermissions =
 *   yield* AWS.LakeFormation.GetEffectivePermissionsForPath();
 *
 * // runtime
 * const { Permissions } = yield* getEffectivePermissions({
 *   ResourceArn: location.resourceArn,
 * });
 * ```
 */
export interface GetEffectivePermissionsForPath extends Binding.Service<
  GetEffectivePermissionsForPath,
  "AWS.LakeFormation.GetEffectivePermissionsForPath",
  () => Effect.Effect<
    (
      request: GetEffectivePermissionsForPathRequest,
    ) => Effect.Effect<
      lf.GetEffectivePermissionsForPathResponse,
      lf.GetEffectivePermissionsForPathError
    >
  >
> {}

export const GetEffectivePermissionsForPath =
  Binding.Service<GetEffectivePermissionsForPath>(
    "AWS.LakeFormation.GetEffectivePermissionsForPath",
  );
