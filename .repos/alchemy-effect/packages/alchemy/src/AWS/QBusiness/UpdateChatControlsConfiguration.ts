import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `UpdateChatControlsConfiguration` request with `applicationId` injected from the bound application.
 */
export interface UpdateChatControlsConfigurationRequest extends Omit<
  qbusiness.UpdateChatControlsConfigurationRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `UpdateChatControlsConfiguration` operation (IAM action
 * `qbusiness:UpdateChatControlsConfiguration`), scoped to one {@link Application}.
 *
 * Updates the application's chat controls — response scope, blocked
 * phrases, topic rules, creator mode, and hallucination reduction.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.UpdateChatControlsConfigurationHttp)`.
 *
 * @binding
 * @section Admin Controls
 * @example Restrict Responses to Enterprise Content
 * ```typescript
 * const updateControls =
 *   yield* AWS.QBusiness.UpdateChatControlsConfiguration(app);
 *
 * yield* updateControls({ responseScope: "ENTERPRISE_CONTENT_ONLY" });
 * ```
 */
export interface UpdateChatControlsConfiguration extends Binding.Service<
  UpdateChatControlsConfiguration,
  "AWS.QBusiness.UpdateChatControlsConfiguration",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: UpdateChatControlsConfigurationRequest,
    ) => Effect.Effect<
      qbusiness.UpdateChatControlsConfigurationResponse,
      qbusiness.UpdateChatControlsConfigurationError
    >
  >
> {}
export const UpdateChatControlsConfiguration =
  Binding.Service<UpdateChatControlsConfiguration>(
    "AWS.QBusiness.UpdateChatControlsConfiguration",
  );
