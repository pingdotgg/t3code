import type * as athena from "@distilled.cloud/aws/athena";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WorkGroup } from "./WorkGroup.ts";

/**
 * Runtime binding for `athena:ListNamedQueries`.
 *
 * Lists the IDs of the saved (named) queries in the bound workgroup — the
 * workgroup name is injected automatically. Provide the implementation with
 * `Effect.provide(AWS.Athena.ListNamedQueriesHttp)`.
 * @binding
 * @section Saved Queries
 * @example List the Workgroup's Named Queries
 * ```typescript
 * // init — bind the operation to the workgroup
 * const listNamedQueries = yield* AWS.Athena.ListNamedQueries(workGroup);
 *
 * // runtime
 * const res = yield* listNamedQueries({ MaxResults: 50 });
 * console.log(res.NamedQueryIds);
 * ```
 */
export interface ListNamedQueries extends Binding.Service<
  ListNamedQueries,
  "AWS.Athena.ListNamedQueries",
  (
    workGroup: WorkGroup,
  ) => Effect.Effect<
    (
      request: Omit<athena.ListNamedQueriesInput, "WorkGroup">,
    ) => Effect.Effect<
      athena.ListNamedQueriesOutput,
      athena.ListNamedQueriesError
    >
  >
> {}

export const ListNamedQueries = Binding.Service<ListNamedQueries>(
  "AWS.Athena.ListNamedQueries",
);
