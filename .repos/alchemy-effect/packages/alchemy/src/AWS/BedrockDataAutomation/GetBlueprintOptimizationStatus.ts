import type * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetBlueprintOptimizationStatus` operation (IAM
 * action `bedrock:GetBlueprintOptimizationStatus` on `*` — optimization
 * invocation ARNs are minted at runtime) — poll the status of a blueprint
 * optimization job started by `InvokeBlueprintOptimizationAsync`.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.BedrockDataAutomation.GetBlueprintOptimizationStatusHttp)`.
 * @binding
 * @section Blueprint Optimization
 * @example Poll An Optimization Job
 * ```typescript
 * // deploy time — account-level binding
 * const getStatus =
 *   yield* AWS.BedrockDataAutomation.GetBlueprintOptimizationStatus();
 *
 * // runtime — poll the invocation returned by InvokeBlueprintOptimizationAsync
 * const { status, outputConfiguration } = yield* getStatus({ invocationArn });
 * if (status === "Success") {
 *   yield* Effect.log(
 *     `optimized schema at ${outputConfiguration?.s3Object.s3Uri}`,
 *   );
 * }
 * ```
 */
export interface GetBlueprintOptimizationStatus extends Binding.Service<
  GetBlueprintOptimizationStatus,
  "AWS.BedrockDataAutomation.GetBlueprintOptimizationStatus",
  () => Effect.Effect<
    (
      request: bda.GetBlueprintOptimizationStatusRequest,
    ) => Effect.Effect<
      bda.GetBlueprintOptimizationStatusResponse,
      bda.GetBlueprintOptimizationStatusError
    >
  >
> {}
export const GetBlueprintOptimizationStatus =
  Binding.Service<GetBlueprintOptimizationStatus>(
    "AWS.BedrockDataAutomation.GetBlueprintOptimizationStatus",
  );
