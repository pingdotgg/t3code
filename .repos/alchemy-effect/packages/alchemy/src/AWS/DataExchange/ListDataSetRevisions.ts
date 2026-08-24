import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSet } from "./DataSet.ts";

/**
 * Runtime binding for `dataexchange:ListDataSetRevisions`.
 *
 * Enumerates the bound data set's revisions, newest first — the
 * building block of "process the latest published revision" consumers.
 * The data set id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.ListDataSetRevisionsHttp)`.
 * @binding
 * @section Reading Data Sets
 * @example Find The Latest Finalized Revision
 * ```typescript
 * const listRevisions = yield* AWS.DataExchange.ListDataSetRevisions(dataSet);
 *
 * // runtime
 * const { Revisions } = yield* listRevisions();
 * const latest = (Revisions ?? []).find((r) => r.Finalized);
 * ```
 */
export interface ListDataSetRevisions extends Binding.Service<
  ListDataSetRevisions,
  "AWS.DataExchange.ListDataSetRevisions",
  (
    dataSet: DataSet,
  ) => Effect.Effect<
    (
      request?: Omit<dataexchange.ListDataSetRevisionsRequest, "DataSetId">,
    ) => Effect.Effect<
      dataexchange.ListDataSetRevisionsResponse,
      dataexchange.ListDataSetRevisionsError
    >
  >
> {}
export const ListDataSetRevisions = Binding.Service<ListDataSetRevisions>(
  "AWS.DataExchange.ListDataSetRevisions",
);
