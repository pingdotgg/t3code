import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link DescribeQAppPermissions} — `instanceId` and `appId` are injected from the bound Q App.
 */
export interface DescribeQAppPermissionsRequest extends Omit<
  qapps.DescribeQAppPermissionsInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:DescribeQAppPermissions`.
 *
 * Reads the principals and actions granted on the bound Q App. Provide the implementation with
 * `Effect.provide(AWS.QApps.DescribeQAppPermissionsHttp)`.
 * @binding
 * @section Permissions
 * @example Describe App Permissions
 * ```typescript
 * // init — bind the operation to the Q App
 * const describeQAppPermissions = yield* AWS.QApps.DescribeQAppPermissions(app);
 *
 * // runtime
 * const permissions = yield* describeQAppPermissions();
 * console.log(permissions.permissions?.length);
 * ```
 */
export interface DescribeQAppPermissions extends Binding.Service<
  DescribeQAppPermissions,
  "AWS.QApps.DescribeQAppPermissions",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request?: DescribeQAppPermissionsRequest,
    ) => Effect.Effect<
      qapps.DescribeQAppPermissionsOutput,
      qapps.DescribeQAppPermissionsError
    >
  >
> {}

export const DescribeQAppPermissions = Binding.Service<DescribeQAppPermissions>(
  "AWS.QApps.DescribeQAppPermissions",
);
