import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface GetPartitionsRequest extends Omit<
  glue.GetPartitionsRequest,
  "DatabaseName" | "TableName" | "CatalogId"
> {}

/**
 * Runtime binding for `glue:GetPartitions`.
 *
 * Lists the bound {@link Table}'s partitions, optionally filtered with a
 * partition-predicate `Expression` (e.g. `dt >= '2026-01-01'`) and paginated
 * via `NextToken`. The database/table names and catalog id are injected from
 * the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.GetPartitionsHttp)`.
 * @binding
 * @section Managing Partitions
 * @example List Recent Partitions
 * ```typescript
 * // init
 * const getPartitions = yield* AWS.Glue.GetPartitions(table);
 *
 * // runtime
 * const { Partitions } = yield* getPartitions({
 *   Expression: "dt >= '2026-01-01'",
 * });
 * ```
 */
export interface GetPartitions extends Binding.Service<
  GetPartitions,
  "AWS.Glue.GetPartitions",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request?: GetPartitionsRequest,
    ) => Effect.Effect<glue.GetPartitionsResponse, glue.GetPartitionsError>
  >
> {}

export const GetPartitions = Binding.Service<GetPartitions>(
  "AWS.Glue.GetPartitions",
);
