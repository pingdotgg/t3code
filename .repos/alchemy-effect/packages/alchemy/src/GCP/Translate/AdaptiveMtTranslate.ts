import type * as translate from "@distilled.cloud/gcp/translate_v3";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AdaptiveMtDataset } from "./AdaptiveMtDataset.ts";

export interface AdaptiveMtTranslateRequest {
  /**
   * Request body. `dataset` is filled from the bound Adaptive MT
   * dataset.
   */
  body?: Omit<translate.AdaptiveMtTranslateRequest, "dataset">;
}

/**
 * Runtime binding for Cloud Translation `adaptiveMtTranslate`.
 *
 * Bind this operation to an {@link AdaptiveMtDataset} in a Function/Action
 * init phase. Provide {@link AdaptiveMtTranslateHttp}.
 *
 * ### Translating with Adaptive MT
 * **Example:** Translate a sentence
 * ```typescript
 * const translateText = yield* GCP.Translate.AdaptiveMtTranslate(dataset);
 * const result = yield* translateText({
 *   body: { content: ["Hello, world"] },
 * });
 * ```
 *
 * @binding
 * @category Translate
 */
export interface AdaptiveMtTranslate extends Binding.Service<
  AdaptiveMtTranslate,
  "GCP.Translate.AdaptiveMtTranslate",
  (
    dataset: AdaptiveMtDataset,
  ) => Effect.Effect<
    (
      request?: AdaptiveMtTranslateRequest,
    ) => Effect.Effect<
      translate.AdaptiveMtTranslateResponse,
      translate.AdaptiveMtTranslateProjectsLocationsError,
      RuntimeContext
    >
  >
> {}

export const AdaptiveMtTranslate = Binding.Service<AdaptiveMtTranslate>(
  "GCP.Translate.AdaptiveMtTranslate",
);
