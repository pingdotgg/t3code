import type * as lf from "@distilled.cloud/aws/lakeformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListPermissions}.
 */
export interface ListPermissionsRequest extends lf.ListPermissionsRequest {}

/**
 * Runtime binding for `lakeformation:ListPermissions`.
 *
 * Lists the Lake Formation permission grants visible to the caller,
 * optionally filtered by principal or resource — runtime authorization
 * introspection. Provide the implementation with
 * `Effect.provide(AWS.LakeFormation.ListPermissionsHttp)`.
 * @binding
 * @section Auditing Permissions
 * @example List Grants on a Database
 * ```typescript
 * // init — account-level binding takes no resource
 * const listPermissions = yield* AWS.LakeFormation.ListPermissions();
 *
 * // runtime
 * const { PrincipalResourcePermissions } = yield* listPermissions({
 *   Resource: { Database: { Name: database.databaseName } },
 * });
 * ```
 */
export interface ListPermissions extends Binding.Service<
  ListPermissions,
  "AWS.LakeFormation.ListPermissions",
  () => Effect.Effect<
    (
      request?: ListPermissionsRequest,
    ) => Effect.Effect<lf.ListPermissionsResponse, lf.ListPermissionsError>
  >
> {}

export const ListPermissions = Binding.Service<ListPermissions>(
  "AWS.LakeFormation.ListPermissions",
);
