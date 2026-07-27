import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `GetChatControlsConfiguration` request with `applicationId` injected from the bound application.
 */
export interface GetChatControlsConfigurationRequest extends Omit<
  qbusiness.GetChatControlsConfigurationRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `GetChatControlsConfiguration` operation (IAM action
 * `qbusiness:GetChatControlsConfiguration`), scoped to one {@link Application}.
 *
 * Reads the application's chat controls: response scope, blocked
 * phrases, topic rules, and creator mode.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.GetChatControlsConfigurationHttp)`.
 *
 * @binding
 * @section Admin Controls
 * @example Read Chat Controls
 * ```typescript
 * const getControls = yield* AWS.QBusiness.GetChatControlsConfiguration(app);
 *
 * const { responseScope, blockedPhrases } = yield* getControls();
 * ```
 */
export interface GetChatControlsConfiguration extends Binding.Service<
  GetChatControlsConfiguration,
  "AWS.QBusiness.GetChatControlsConfiguration",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: GetChatControlsConfigurationRequest,
    ) => Effect.Effect<
      qbusiness.GetChatControlsConfigurationResponse,
      qbusiness.GetChatControlsConfigurationError
    >
  >
> {}
export const GetChatControlsConfiguration =
  Binding.Service<GetChatControlsConfiguration>(
    "AWS.QBusiness.GetChatControlsConfiguration",
  );
