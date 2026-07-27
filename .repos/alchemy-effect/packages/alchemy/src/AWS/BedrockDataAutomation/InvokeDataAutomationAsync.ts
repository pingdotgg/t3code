import type * as bdar from "@distilled.cloud/aws/bedrock-data-automation-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataAutomationProject } from "./DataAutomationProject.ts";

/**
 * `InvokeDataAutomationAsync` request with `dataAutomationConfiguration`
 * (project ARN + stage) injected from the bound
 * {@link DataAutomationProject}.
 */
export interface InvokeDataAutomationAsyncRequest extends Omit<
  bdar.InvokeDataAutomationAsyncRequest,
  "dataAutomationConfiguration"
> {}

/**
 * Runtime binding for the `InvokeDataAutomationAsync` operation (IAM action
 * `bedrock:InvokeDataAutomationAsync` on the project ARN + the account's
 * data automation profiles) — start an asynchronous Bedrock Data Automation
 * job against the bound project from a deployed Function.
 *
 * The binding is constructed with the target {@link DataAutomationProject};
 * its ARN and stage are injected into every runtime request as
 * `dataAutomationConfiguration`. The caller supplies the S3 input/output
 * locations and the cross-region data automation profile ARN (e.g.
 * `arn:aws:bedrock:us-west-2:{account}:data-automation-profile/us.data-automation-v1`).
 * The calling role also needs `s3:GetObject` on the input and `s3:PutObject`
 * on the output location — Bedrock Data Automation accesses S3 with the
 * caller's permissions. Provide the implementation with
 * `Effect.provide(AWS.BedrockDataAutomation.InvokeDataAutomationAsyncHttp)`.
 * @binding
 * @section Invoking Data Automation
 * @example Start An Async Job For An Uploaded Document
 * ```typescript
 * // deploy time — bind the project
 * const invokeAsync = yield* AWS.BedrockDataAutomation.InvokeDataAutomationAsync(project);
 *
 * // runtime — process a document already in S3
 * const { invocationArn } = yield* invokeAsync({
 *   inputConfiguration: { s3Uri: `s3://${bucket}/uploads/invoice.pdf` },
 *   outputConfiguration: { s3Uri: `s3://${bucket}/results/` },
 *   dataAutomationProfileArn: profileArn,
 * });
 * ```
 *
 * @example Get Notified Via EventBridge When The Job Settles
 * ```typescript
 * yield* invokeAsync({
 *   inputConfiguration: { s3Uri: input },
 *   outputConfiguration: { s3Uri: output },
 *   dataAutomationProfileArn: profileArn,
 *   notificationConfiguration: {
 *     eventBridgeConfiguration: { eventBridgeEnabled: true },
 *   },
 * });
 * // pair with AWS.BedrockDataAutomation.consumeDataAutomationJobEvents
 * ```
 */
export interface InvokeDataAutomationAsync extends Binding.Service<
  InvokeDataAutomationAsync,
  "AWS.BedrockDataAutomation.InvokeDataAutomationAsync",
  (
    project: DataAutomationProject,
  ) => Effect.Effect<
    (
      request: InvokeDataAutomationAsyncRequest,
    ) => Effect.Effect<
      bdar.InvokeDataAutomationAsyncResponse,
      bdar.InvokeDataAutomationAsyncError
    >
  >
> {}
export const InvokeDataAutomationAsync =
  Binding.Service<InvokeDataAutomationAsync>(
    "AWS.BedrockDataAutomation.InvokeDataAutomationAsync",
  );
