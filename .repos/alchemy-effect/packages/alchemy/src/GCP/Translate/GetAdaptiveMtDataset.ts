import type * as translate from "@distilled.cloud/gcp/translate_v3";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AdaptiveMtDataset } from "./AdaptiveMtDataset.ts";

export interface GetAdaptiveMtDatasetRequest extends Omit<
  translate.GetProjectsLocationsAdaptiveMtDatasetsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Translation `adaptiveMtDatasets.get`.
 *
 * Bind this operation to an {@link AdaptiveMtDataset} in a Function/Action
 * init phase. Provide {@link GetAdaptiveMtDatasetHttp}.
 *
 * ### Reading a Dataset
 * **Example:** Read the bound dataset
 * ```typescript
 * const getDataset = yield* GCP.Translate.GetAdaptiveMtDataset(dataset);
 * const live = yield* getDataset();
 * ```
 *
 * @binding
 * @category Translate
 */
export interface GetAdaptiveMtDataset extends Binding.Service<
  GetAdaptiveMtDataset,
  "GCP.Translate.GetAdaptiveMtDataset",
  (
    dataset: AdaptiveMtDataset,
  ) => Effect.Effect<
    (
      request?: GetAdaptiveMtDatasetRequest,
    ) => Effect.Effect<
      translate.AdaptiveMtDataset,
      translate.GetProjectsLocationsAdaptiveMtDatasetsError,
      RuntimeContext
    >
  >
> {}

export const GetAdaptiveMtDataset = Binding.Service<GetAdaptiveMtDataset>(
  "GCP.Translate.GetAdaptiveMtDataset",
);
