import type * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Blueprint } from "./Blueprint.ts";

/**
 * `CopyBlueprintStage` request with `blueprintArn` injected from the bound
 * {@link Blueprint}.
 */
export interface CopyBlueprintStageRequest extends Omit<
  bda.CopyBlueprintStageRequest,
  "blueprintArn"
> {}

/**
 * Runtime binding for the `CopyBlueprintStage` operation (IAM action
 * `bedrock:CopyBlueprintStage` on the blueprint ARN) — copy the bound
 * blueprint between its `DEVELOPMENT` and `LIVE` stages from a deployed
 * Function (e.g. promote a tuned development schema to live).
 *
 * Provide the implementation with
 * `Effect.provide(AWS.BedrockDataAutomation.CopyBlueprintStageHttp)`.
 * @binding
 * @section Blueprint Management
 * @example Promote Development To Live
 * ```typescript
 * // deploy time — bind the blueprint
 * const copyStage =
 *   yield* AWS.BedrockDataAutomation.CopyBlueprintStage(blueprint);
 *
 * // runtime — promote the development copy
 * yield* copyStage({ sourceStage: "DEVELOPMENT", targetStage: "LIVE" });
 * ```
 */
export interface CopyBlueprintStage extends Binding.Service<
  CopyBlueprintStage,
  "AWS.BedrockDataAutomation.CopyBlueprintStage",
  (
    blueprint: Blueprint,
  ) => Effect.Effect<
    (
      request: CopyBlueprintStageRequest,
    ) => Effect.Effect<
      bda.CopyBlueprintStageResponse,
      bda.CopyBlueprintStageError
    >
  >
> {}
export const CopyBlueprintStage = Binding.Service<CopyBlueprintStage>(
  "AWS.BedrockDataAutomation.CopyBlueprintStage",
);
