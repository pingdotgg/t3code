import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface ListApplicationOperationsRequest extends Omit<
  SVC.ListApplicationOperationsRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:ListApplicationOperations` — pages
 * through the bound application's async operation history (starts, stops,
 * updates, rollbacks and their outcomes).
 * @binding
 * @section Operating the Application
 * @example List recent failed operations
 * ```typescript
 * const listOperations = yield* AWS.KinesisAnalyticsV2.ListApplicationOperations(app);
 *
 * const { ApplicationOperationInfoList } = yield* listOperations({
 *   OperationStatus: "FAILED",
 * });
 * ```
 */
export interface ListApplicationOperations extends Binding.Service<
  ListApplicationOperations,
  "AWS.KinesisAnalyticsV2.ListApplicationOperations",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request?: ListApplicationOperationsRequest,
    ) => Effect.Effect<
      SVC.ListApplicationOperationsResponse,
      SVC.ListApplicationOperationsError
    >
  >
> {}
export const ListApplicationOperations =
  Binding.Service<ListApplicationOperations>(
    "AWS.KinesisAnalyticsV2.ListApplicationOperations",
  );
