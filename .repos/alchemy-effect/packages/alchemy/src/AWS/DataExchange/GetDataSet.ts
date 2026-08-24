import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSet } from "./DataSet.ts";

/**
 * Runtime binding for `dataexchange:GetDataSet`.
 *
 * Reads the bound data set's detail — name, description, asset type,
 * origin (`OWNED` or `ENTITLED`), and origin details. The data set id is
 * injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.GetDataSetHttp)`.
 * @binding
 * @section Reading Data Sets
 * @example Read The Bound Data Set
 * ```typescript
 * // init — bind the operation to the data set
 * const getDataSet = yield* AWS.DataExchange.GetDataSet(dataSet);
 *
 * // runtime
 * const detail = yield* getDataSet();
 * yield* Effect.log(`data set ${detail.Name} (${detail.AssetType})`);
 * ```
 */
export interface GetDataSet extends Binding.Service<
  GetDataSet,
  "AWS.DataExchange.GetDataSet",
  (
    dataSet: DataSet,
  ) => Effect.Effect<
    () => Effect.Effect<
      dataexchange.GetDataSetResponse,
      dataexchange.GetDataSetError
    >
  >
> {}
export const GetDataSet = Binding.Service<GetDataSet>(
  "AWS.DataExchange.GetDataSet",
);
