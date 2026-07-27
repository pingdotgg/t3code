import type * as apprunner from "@distilled.cloud/aws/apprunner";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

export interface ListOperationsRequest extends Omit<
  apprunner.ListOperationsRequest,
  "ServiceArn"
> {}

/**
 * List the operations that occurred on an App Runner {@link Service} (most
 * recent first) from a Lambda (or other AWS runtime) — the tracking
 * counterpart to the asynchronous {@link StartDeployment},
 * {@link PauseService}, and {@link ResumeService} calls, whose returned
 * `OperationId`s appear here with `Status` transitions
 * (`IN_PROGRESS` -> `SUCCEEDED` / `FAILED` / `ROLLBACK_*`).
 *
 * Provide `AppRunner.ListOperationsHttp` on the hosting function's Effect
 * to implement the binding.
 *
 * @binding
 * @section Tracking Operations
 * @example Track a deployment to completion
 * ```typescript
 * const listOperations = yield* AppRunner.ListOperations(service);
 * const { OperationSummaryList } = yield* listOperations({ MaxResults: 5 });
 * const deployment = OperationSummaryList?.find((op) => op.Id === operationId);
 * // deployment?.Status -> "IN_PROGRESS" | "SUCCEEDED" | ...
 * ```
 */
export interface ListOperations extends Binding.Service<
  ListOperations,
  "AWS.AppRunner.ListOperations",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request?: ListOperationsRequest,
    ) => Effect.Effect<
      apprunner.ListOperationsResponse,
      apprunner.ListOperationsError
    >
  >
> {}
export const ListOperations = Binding.Service<ListOperations>(
  "AWS.AppRunner.ListOperations",
);
