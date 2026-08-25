import type * as bdar from "@distilled.cloud/aws/bedrock-data-automation-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetDataAutomationStatus` operation (IAM action
 * `bedrock:GetDataAutomationStatus` on `*` — invocation ARNs are minted at
 * runtime) — poll the status of an asynchronous Bedrock Data Automation job
 * from a deployed Function.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.BedrockDataAutomation.GetDataAutomationStatusHttp)`.
 * @binding
 * @section Polling Job Status
 * @example Check An Async Job's Status
 * ```typescript
 * // deploy time — account-level binding
 * const getStatus = yield* AWS.BedrockDataAutomation.GetDataAutomationStatus();
 *
 * // runtime — poll the invocation returned by InvokeDataAutomationAsync
 * const { status, outputConfiguration } = yield* getStatus({ invocationArn });
 * if (status === "Success") {
 *   yield* Effect.log(`results at ${outputConfiguration?.s3Uri}`);
 * }
 * ```
 */
export interface GetDataAutomationStatus extends Binding.Service<
  GetDataAutomationStatus,
  "AWS.BedrockDataAutomation.GetDataAutomationStatus",
  () => Effect.Effect<
    (
      request: bdar.GetDataAutomationStatusRequest,
    ) => Effect.Effect<
      bdar.GetDataAutomationStatusResponse,
      bdar.GetDataAutomationStatusError
    >
  >
> {}
export const GetDataAutomationStatus = Binding.Service<GetDataAutomationStatus>(
  "AWS.BedrockDataAutomation.GetDataAutomationStatus",
);
