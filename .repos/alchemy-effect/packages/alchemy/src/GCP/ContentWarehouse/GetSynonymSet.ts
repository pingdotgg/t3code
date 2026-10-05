import type * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { SynonymSet } from "./SynonymSet.ts";

export interface GetSynonymSetRequest extends Omit<
  cw.GetProjectsLocationsSynonymSetsRequest,
  "name"
> {}

/**
 * Runtime binding for Document AI Warehouse `synonymSets.get`.
 *
 * Grants `roles/contentwarehouse.admin` on the project because
 * `contentwarehouse.synonymSets.get` is only in that role and Document AI
 * Warehouse has no per-resource IAM.
 *
 * Bind this operation to a {@link SynonymSet} in a Function/Action init
 * phase. Provide {@link GetSynonymSetHttp}.
 *
 * ### Reading Synonym Sets
 * **Example:** Read the bound synonym set
 * ```typescript
 * const getSynonyms = yield* GCP.ContentWarehouse.GetSynonymSet(synonyms);
 * const live = yield* getSynonyms();
 * ```
 *
 * @binding
 * @category ContentWarehouse
 */
export interface GetSynonymSet extends Binding.Service<
  GetSynonymSet,
  "GCP.ContentWarehouse.GetSynonymSet",
  (
    synonymSet: SynonymSet,
  ) => Effect.Effect<
    (
      request?: GetSynonymSetRequest,
    ) => Effect.Effect<
      cw.GoogleCloudContentwarehouseV1SynonymSet,
      cw.GetProjectsLocationsSynonymSetsError,
      RuntimeContext
    >
  >
> {}

export const GetSynonymSet = Binding.Service<GetSynonymSet>(
  "GCP.ContentWarehouse.GetSynonymSet",
);
