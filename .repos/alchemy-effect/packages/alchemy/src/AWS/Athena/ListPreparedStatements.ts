import type * as athena from "@distilled.cloud/aws/athena";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WorkGroup } from "./WorkGroup.ts";

/**
 * Runtime binding for `athena:ListPreparedStatements`.
 *
 * Lists the prepared statements (name + last-modified time) in the bound
 * workgroup — the workgroup name is injected automatically. Provide the
 * implementation with `Effect.provide(AWS.Athena.ListPreparedStatementsHttp)`.
 * @binding
 * @section Prepared Statements
 * @example List the Workgroup's Prepared Statements
 * ```typescript
 * // init — bind the operation to the workgroup
 * const listPreparedStatements =
 *   yield* AWS.Athena.ListPreparedStatements(workGroup);
 *
 * // runtime
 * const res = yield* listPreparedStatements({ MaxResults: 50 });
 * console.log(res.PreparedStatements?.map((s) => s.StatementName));
 * ```
 */
export interface ListPreparedStatements extends Binding.Service<
  ListPreparedStatements,
  "AWS.Athena.ListPreparedStatements",
  (
    workGroup: WorkGroup,
  ) => Effect.Effect<
    (
      request: Omit<athena.ListPreparedStatementsInput, "WorkGroup">,
    ) => Effect.Effect<
      athena.ListPreparedStatementsOutput,
      athena.ListPreparedStatementsError
    >
  >
> {}

export const ListPreparedStatements = Binding.Service<ListPreparedStatements>(
  "AWS.Athena.ListPreparedStatements",
);
