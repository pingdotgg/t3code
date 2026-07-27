import type * as athena from "@distilled.cloud/aws/athena";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WorkGroup } from "./WorkGroup.ts";

/**
 * Runtime binding for `athena:ListQueryExecutions`.
 *
 * Lists recent query execution IDs in the bound workgroup (newest first) —
 * the workgroup name is injected automatically. Provide the implementation
 * with `Effect.provide(AWS.Athena.ListQueryExecutionsHttp)`.
 * @binding
 * @section Inspecting Query Executions
 * @example List Recent Executions in the Workgroup
 * ```typescript
 * // init — bind the operation to the workgroup
 * const listQueryExecutions = yield* AWS.Athena.ListQueryExecutions(workGroup);
 *
 * // runtime
 * const res = yield* listQueryExecutions({ MaxResults: 10 });
 * console.log(res.QueryExecutionIds);
 * ```
 */
export interface ListQueryExecutions extends Binding.Service<
  ListQueryExecutions,
  "AWS.Athena.ListQueryExecutions",
  (
    workGroup: WorkGroup,
  ) => Effect.Effect<
    (
      request: Omit<athena.ListQueryExecutionsInput, "WorkGroup">,
    ) => Effect.Effect<
      athena.ListQueryExecutionsOutput,
      athena.ListQueryExecutionsError
    >
  >
> {}

export const ListQueryExecutions = Binding.Service<ListQueryExecutions>(
  "AWS.Athena.ListQueryExecutions",
);
