import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link AssociateQAppWithUser} — `instanceId` and `appId` are injected from the bound Q App.
 */
export interface AssociateQAppWithUserRequest extends Omit<
  qapps.AssociateQAppWithUserInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:AssociateQAppWithUser`.
 *
 * Links the calling identity to the bound Q App, marking it as a favorite in the user's inventory. Provide the implementation with
 * `Effect.provide(AWS.QApps.AssociateQAppWithUserHttp)`.
 * @binding
 * @section User Inventory
 * @example Favorite the App
 * ```typescript
 * // init — bind the operation to the Q App
 * const associateQAppWithUser = yield* AWS.QApps.AssociateQAppWithUser(app);
 *
 * // runtime
 * yield* associateQAppWithUser();
 * ```
 */
export interface AssociateQAppWithUser extends Binding.Service<
  AssociateQAppWithUser,
  "AWS.QApps.AssociateQAppWithUser",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request?: AssociateQAppWithUserRequest,
    ) => Effect.Effect<
      qapps.AssociateQAppWithUserResponse,
      qapps.AssociateQAppWithUserError
    >
  >
> {}

export const AssociateQAppWithUser = Binding.Service<AssociateQAppWithUser>(
  "AWS.QApps.AssociateQAppWithUser",
);
