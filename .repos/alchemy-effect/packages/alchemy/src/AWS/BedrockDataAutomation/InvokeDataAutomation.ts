import type * as bdar from "@distilled.cloud/aws/bedrock-data-automation-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataAutomationProject } from "./DataAutomationProject.ts";

/**
 * `InvokeDataAutomation` request with `dataAutomationConfiguration`
 * (project ARN + stage) injected from the bound
 * {@link DataAutomationProject}.
 */
export interface InvokeDataAutomationRequest extends Omit<
  bdar.InvokeDataAutomationRequest,
  "dataAutomationConfiguration"
> {}

/**
 * Runtime binding for the synchronous `InvokeDataAutomation` operation (IAM
 * action `bedrock:InvokeDataAutomation` on the project ARN + the account's
 * data automation profiles) — process a file inline against the bound
 * project from a deployed Function and get the extracted output back in the
 * response.
 *
 * The bound {@link DataAutomationProject} must be created with
 * `projectType: "SYNC"`. Input can be passed inline as `bytes` or as an
 * `s3Uri`; the caller supplies the cross-region data automation profile ARN
 * (e.g. `…:data-automation-profile/us.data-automation-v1`). Provide the
 * implementation with
 * `Effect.provide(AWS.BedrockDataAutomation.InvokeDataAutomationHttp)`.
 * @binding
 * @section Invoking Data Automation
 * @example Extract Fields From An Inline Document
 * ```typescript
 * // deploy time — bind the SYNC project
 * const invoke = yield* AWS.BedrockDataAutomation.InvokeDataAutomation(syncProject);
 *
 * // runtime — process request bytes synchronously
 * const result = yield* invoke({
 *   inputConfiguration: { bytes: documentBytes },
 *   dataAutomationProfileArn: profileArn,
 * });
 * const fields = result.outputSegments?.[0]?.customOutput;
 * ```
 */
export interface InvokeDataAutomation extends Binding.Service<
  InvokeDataAutomation,
  "AWS.BedrockDataAutomation.InvokeDataAutomation",
  (
    project: DataAutomationProject,
  ) => Effect.Effect<
    (
      request: InvokeDataAutomationRequest,
    ) => Effect.Effect<
      bdar.InvokeDataAutomationResponse,
      bdar.InvokeDataAutomationError
    >
  >
> {}
export const InvokeDataAutomation = Binding.Service<InvokeDataAutomation>(
  "AWS.BedrockDataAutomation.InvokeDataAutomation",
);
