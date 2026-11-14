import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Application } from "./Application.ts";

export interface ListApplicationOperationsRequest extends Omit<
  SVC.ListApplicationOperationsRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:ListApplicationOperations` — pages
 * through the bound application's async operation history (starts, stops,
 * updates, rollbacks and their outcomes).
 * ### Operating the Application
 * **Example:** List recent failed operations
 * ```typescript
 * const listOperations = yield* AWS.KinesisAnalyticsV2.ListApplicationOperations(app);
 *
 * const { ApplicationOperationInfoList } = yield* listOperations({
 *   OperationStatus: "FAILED",
 * });
 * ```
 *
 * @binding
 */
export interface ListApplicationOperations extends Binding.Service<
  ListApplicationOperations,
  "AWS.KinesisAnalyticsV2.ListApplicationOperations",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request?: ListApplicationOperationsRequest,
    ) => Effect.Effect<SVC.ListApplicationOperationsResponse, SVC.ListApplicationOperationsError>
  >
> {}
export const ListApplicationOperations = Binding.Service<ListApplicationOperations>(
  "AWS.KinesisAnalyticsV2.ListApplicationOperations",
);
