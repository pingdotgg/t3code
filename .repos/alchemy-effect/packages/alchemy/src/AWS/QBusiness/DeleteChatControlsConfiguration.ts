import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `DeleteChatControlsConfiguration` request with `applicationId` injected from the bound application.
 */
export interface DeleteChatControlsConfigurationRequest extends Omit<
  qbusiness.DeleteChatControlsConfigurationRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `DeleteChatControlsConfiguration` operation (IAM action
 * `qbusiness:DeleteChatControlsConfiguration`), scoped to one {@link Application}.
 *
 * Deletes the application's chat controls configuration.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.DeleteChatControlsConfigurationHttp)`.
 *
 * @binding
 * @section Admin Controls
 * @example Delete Chat Controls
 * ```typescript
 * const deleteControls =
 *   yield* AWS.QBusiness.DeleteChatControlsConfiguration(app);
 *
 * yield* deleteControls();
 * ```
 */
export interface DeleteChatControlsConfiguration extends Binding.Service<
  DeleteChatControlsConfiguration,
  "AWS.QBusiness.DeleteChatControlsConfiguration",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: DeleteChatControlsConfigurationRequest,
    ) => Effect.Effect<
      qbusiness.DeleteChatControlsConfigurationResponse,
      qbusiness.DeleteChatControlsConfigurationError
    >
  >
> {}
export const DeleteChatControlsConfiguration =
  Binding.Service<DeleteChatControlsConfiguration>(
    "AWS.QBusiness.DeleteChatControlsConfiguration",
  );
