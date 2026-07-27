import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `controltower:ListControlOperations`.
 *
 * An account-level operation that enumerates recent control operations
 * (enables, disables, updates, and resets), optionally filtered by status,
 * control, or target. Useful for governance dashboards that surface
 * in-flight or failed guardrail deployments. Provide the implementation
 * with `Effect.provide(AWS.ControlTower.ListControlOperationsHttp)`.
 * @binding
 * @section Polling Asynchronous Operations
 * @example List Failed Control Operations
 * ```typescript
 * // init — account-level binding takes no resource
 * const listControlOperations = yield* AWS.ControlTower.ListControlOperations();
 *
 * // runtime
 * const result = yield* listControlOperations({
 *   filter: { statuses: ["FAILED"] },
 * });
 * console.log(result.controlOperations.length);
 * ```
 */
export interface ListControlOperations extends Binding.Service<
  ListControlOperations,
  "AWS.ControlTower.ListControlOperations",
  () => Effect.Effect<
    (
      request?: controltower.ListControlOperationsInput,
    ) => Effect.Effect<
      controltower.ListControlOperationsOutput,
      controltower.ListControlOperationsError
    >
  >
> {}

export const ListControlOperations = Binding.Service<ListControlOperations>(
  "AWS.ControlTower.ListControlOperations",
);
