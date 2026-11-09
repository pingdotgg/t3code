import type * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
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
