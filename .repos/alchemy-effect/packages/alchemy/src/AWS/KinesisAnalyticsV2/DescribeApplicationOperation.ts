import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface DescribeApplicationOperationRequest extends Omit<
  SVC.DescribeApplicationOperationRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:DescribeApplicationOperation` —
 * reads the status of an async operation on the bound application (the
 * `OperationId` returned by start/stop/rollback/update), e.g. to poll a
 * start to completion.
 * @binding
 * @section Operating the Application
 * @example Poll an operation to completion
 * ```typescript
 * const describeOperation = yield* AWS.KinesisAnalyticsV2.DescribeApplicationOperation(app);
 *
 * const { ApplicationOperationInfoDetails } = yield* describeOperation({
 *   OperationId: operationId,
 * });
 * ```
 */
export interface DescribeApplicationOperation extends Binding.Service<
  DescribeApplicationOperation,
  "AWS.KinesisAnalyticsV2.DescribeApplicationOperation",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request: DescribeApplicationOperationRequest,
    ) => Effect.Effect<
      SVC.DescribeApplicationOperationResponse,
      SVC.DescribeApplicationOperationError
    >
  >
> {}
export const DescribeApplicationOperation =
  Binding.Service<DescribeApplicationOperation>(
    "AWS.KinesisAnalyticsV2.DescribeApplicationOperation",
  );
