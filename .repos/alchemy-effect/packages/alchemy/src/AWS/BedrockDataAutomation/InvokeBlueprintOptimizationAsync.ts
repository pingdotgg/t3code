import type * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Blueprint } from "./Blueprint.ts";

/**
 * `InvokeBlueprintOptimizationAsync` request with the `blueprint` object
 * (ARN + stage) injected from the bound {@link Blueprint}.
 */
export interface InvokeBlueprintOptimizationAsyncRequest extends Omit<
  bda.InvokeBlueprintOptimizationAsyncRequest,
  "blueprint"
> {}

/**
 * Runtime binding for the `InvokeBlueprintOptimizationAsync` operation (IAM
 * action `bedrock:InvokeBlueprintOptimizationAsync` on the blueprint ARN +
 * the account's data automation profiles) — start an asynchronous job that
 * tunes the bound blueprint's schema against labeled samples (asset +
 * ground-truth pairs in S3) from a deployed Function.
 *
 * The samples and output location are read/written with the caller's S3
 * permissions. Poll the returned invocation with the
 * `GetBlueprintOptimizationStatus` binding. Provide the implementation with
 * `Effect.provide(AWS.BedrockDataAutomation.InvokeBlueprintOptimizationAsyncHttp)`.
 * @binding
 * @section Blueprint Optimization
 * @example Optimize A Blueprint Against Labeled Samples
 * ```typescript
 * // deploy time — bind the blueprint
 * const optimize =
 *   yield* AWS.BedrockDataAutomation.InvokeBlueprintOptimizationAsync(blueprint);
 *
 * // runtime — start the optimization job
 * const { invocationArn } = yield* optimize({
 *   samples: [
 *     {
 *       assetS3Object: { s3Uri: `s3://${bucket}/samples/invoice-1.pdf` },
 *       groundTruthS3Object: { s3Uri: `s3://${bucket}/samples/invoice-1.json` },
 *     },
 *   ],
 *   outputConfiguration: {
 *     s3Object: { s3Uri: `s3://${bucket}/optimization-results/` },
 *   },
 *   dataAutomationProfileArn: profileArn,
 * });
 * ```
 */
export interface InvokeBlueprintOptimizationAsync extends Binding.Service<
  InvokeBlueprintOptimizationAsync,
  "AWS.BedrockDataAutomation.InvokeBlueprintOptimizationAsync",
  (
    blueprint: Blueprint,
  ) => Effect.Effect<
    (
      request: InvokeBlueprintOptimizationAsyncRequest,
    ) => Effect.Effect<
      bda.InvokeBlueprintOptimizationAsyncResponse,
      bda.InvokeBlueprintOptimizationAsyncError
    >
  >
> {}
export const InvokeBlueprintOptimizationAsync =
  Binding.Service<InvokeBlueprintOptimizationAsync>(
    "AWS.BedrockDataAutomation.InvokeBlueprintOptimizationAsync",
  );
