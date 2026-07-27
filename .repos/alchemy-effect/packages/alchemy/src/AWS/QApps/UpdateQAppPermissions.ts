import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link UpdateQAppPermissions} — `instanceId` and `appId` are injected from the bound Q App.
 */
export interface UpdateQAppPermissionsRequest extends Omit<
  qapps.UpdateQAppPermissionsInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:UpdateQAppPermissions`.
 *
 * Grants or revokes read/edit permissions on the bound Q App for Identity Center principals. Provide the implementation with
 * `Effect.provide(AWS.QApps.UpdateQAppPermissionsHttp)`.
 * @binding
 * @section Permissions
 * @example Grant Read Access
 * ```typescript
 * // init — bind the operation to the Q App
 * const updateQAppPermissions = yield* AWS.QApps.UpdateQAppPermissions(app);
 *
 * // runtime
 * yield* updateQAppPermissions({
 *   grantPermissions: [{ action: "read", principal: userId }],
 * });
 * ```
 */
export interface UpdateQAppPermissions extends Binding.Service<
  UpdateQAppPermissions,
  "AWS.QApps.UpdateQAppPermissions",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request?: UpdateQAppPermissionsRequest,
    ) => Effect.Effect<
      qapps.UpdateQAppPermissionsOutput,
      qapps.UpdateQAppPermissionsError
    >
  >
> {}

export const UpdateQAppPermissions = Binding.Service<UpdateQAppPermissions>(
  "AWS.QApps.UpdateQAppPermissions",
);
