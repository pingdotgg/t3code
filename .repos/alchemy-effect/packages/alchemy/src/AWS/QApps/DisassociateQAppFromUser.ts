import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link DisassociateQAppFromUser} — `instanceId` and `appId` are injected from the bound Q App.
 */
export interface DisassociateQAppFromUserRequest extends Omit<
  qapps.DisassociateQAppFromUserInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:DisassociateQAppFromUser`.
 *
 * Removes the bound Q App from the calling identity's inventory of favorited apps. Provide the implementation with
 * `Effect.provide(AWS.QApps.DisassociateQAppFromUserHttp)`.
 * @binding
 * @section User Inventory
 * @example Unfavorite the App
 * ```typescript
 * // init — bind the operation to the Q App
 * const disassociateQAppFromUser = yield* AWS.QApps.DisassociateQAppFromUser(app);
 *
 * // runtime
 * yield* disassociateQAppFromUser();
 * ```
 */
export interface DisassociateQAppFromUser extends Binding.Service<
  DisassociateQAppFromUser,
  "AWS.QApps.DisassociateQAppFromUser",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request?: DisassociateQAppFromUserRequest,
    ) => Effect.Effect<
      qapps.DisassociateQAppFromUserResponse,
      qapps.DisassociateQAppFromUserError
    >
  >
> {}

export const DisassociateQAppFromUser =
  Binding.Service<DisassociateQAppFromUser>(
    "AWS.QApps.DisassociateQAppFromUser",
  );
