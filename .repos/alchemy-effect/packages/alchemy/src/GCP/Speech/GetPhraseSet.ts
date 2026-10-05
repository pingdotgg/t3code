import type * as speech from "@distilled.cloud/gcp/speech_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { PhraseSet } from "./PhraseSet.ts";

export interface GetPhraseSetRequest extends Omit<
  speech.GetProjectsLocationsPhraseSetsRequest,
  "name"
> {}

/**
 * Runtime binding for Speech-to-Text `phraseSets.get`.
 *
 * Bind this operation to a {@link PhraseSet} in a Function/Action init
 * phase. Provide {@link GetPhraseSetHttp}.
 *
 * Grants `roles/speech.client` on the project because Speech-to-Text has no
 * resource-level IAM.
 *
 * ### Reading a Phrase Set
 * **Example:** Read the bound phrase set
 * ```typescript
 * const getPhraseSet = yield* GCP.Speech.GetPhraseSet(hints);
 * const live = yield* getPhraseSet();
 * ```
 *
 * @binding
 * @category Speech
 */
export interface GetPhraseSet extends Binding.Service<
  GetPhraseSet,
  "GCP.Speech.GetPhraseSet",
  (
    phraseSet: PhraseSet,
  ) => Effect.Effect<
    (
      request?: GetPhraseSetRequest,
    ) => Effect.Effect<
      speech.PhraseSet,
      speech.GetProjectsLocationsPhraseSetsError,
      RuntimeContext
    >
  >
> {}

export const GetPhraseSet = Binding.Service<GetPhraseSet>(
  "GCP.Speech.GetPhraseSet",
);
