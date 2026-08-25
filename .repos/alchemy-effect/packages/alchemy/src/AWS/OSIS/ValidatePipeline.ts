import type * as osis from "@distilled.cloud/aws/osis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `osis:ValidatePipeline`.
 *
 * Checks whether a Data Prepper pipeline configuration body is valid prior to
 * creation — the building block of config-authoring tooling (validate a
 * generated configuration before calling `CreatePipeline`, or lint
 * user-submitted configs in a self-service portal). Account-level: no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.OSIS.ValidatePipelineHttp)`.
 * @binding
 * @section Authoring Pipeline Configurations
 * @example Validate a Configuration Body
 * ```typescript
 * // init — account-level binding, no resource argument
 * const validatePipeline = yield* AWS.OSIS.ValidatePipeline();
 *
 * // runtime
 * const { isValid, Errors } = yield* validatePipeline({
 *   PipelineConfigurationBody: configYaml,
 * });
 * if (!isValid) {
 *   yield* Effect.logError(Errors?.map((e) => e.Message).join("\n") ?? "");
 * }
 * ```
 */
export interface ValidatePipeline extends Binding.Service<
  ValidatePipeline,
  "AWS.OSIS.ValidatePipeline",
  () => Effect.Effect<
    (
      request: osis.ValidatePipelineRequest,
    ) => Effect.Effect<
      osis.ValidatePipelineResponse,
      osis.ValidatePipelineError
    >
  >
> {}
export const ValidatePipeline = Binding.Service<ValidatePipeline>(
  "AWS.OSIS.ValidatePipeline",
);
