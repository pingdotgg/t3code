import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:PutResourceConfig` — record the
 * configuration item of a custom (third-party) resource type with AWS
 * Config, e.g. `MyCompany::Service::Widget`.
 *
 * Provide `Config.PutResourceConfigHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Recording Custom Resources
 * @example Record a Custom Resource
 * ```typescript
 * // init — grants config:PutResourceConfig
 * const putResourceConfig = yield* AWS.Config.PutResourceConfig();
 *
 * // runtime
 * yield* putResourceConfig({
 *   ResourceType: "MyCompany::Service::Widget",
 *   SchemaVersionId: "1.0",
 *   ResourceId: "widget-1",
 *   Configuration: JSON.stringify({ color: "teal" }),
 * });
 * ```
 */
export interface PutResourceConfig extends Binding.Service<
  PutResourceConfig,
  "AWS.Config.PutResourceConfig",
  () => Effect.Effect<
    (
      request: config.PutResourceConfigRequest,
    ) => Effect.Effect<
      config.PutResourceConfigResponse,
      config.PutResourceConfigError
    >
  >
> {}

export const PutResourceConfig = Binding.Service<PutResourceConfig>(
  "AWS.Config.PutResourceConfig",
);
