import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:DeleteResourceConfig` — delete the recorded
 * configuration of a custom (third-party) resource previously recorded via
 * `PutResourceConfig`.
 *
 * Provide `Config.DeleteResourceConfigHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Recording Custom Resources
 * @example Delete a Custom Resource's Configuration
 * ```typescript
 * // init — grants config:DeleteResourceConfig
 * const deleteResourceConfig = yield* AWS.Config.DeleteResourceConfig();
 *
 * // runtime
 * yield* deleteResourceConfig({
 *   ResourceType: "MyCompany::Service::Widget",
 *   ResourceId: "widget-1",
 * });
 * ```
 */
export interface DeleteResourceConfig extends Binding.Service<
  DeleteResourceConfig,
  "AWS.Config.DeleteResourceConfig",
  () => Effect.Effect<
    (
      request: config.DeleteResourceConfigRequest,
    ) => Effect.Effect<
      config.DeleteResourceConfigResponse,
      config.DeleteResourceConfigError
    >
  >
> {}

export const DeleteResourceConfig = Binding.Service<DeleteResourceConfig>(
  "AWS.Config.DeleteResourceConfig",
);
