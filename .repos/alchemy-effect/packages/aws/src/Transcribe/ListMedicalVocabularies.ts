import type * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `transcribe:ListMedicalVocabularies` — list the medical vocabularies in the account.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListMedicalVocabularies` on `*`.
 *
 * ### Medical Vocabularies
 * **Example:** List Medical Vocabularies
 * ```typescript
 * // init
 * const listMedicalVocabularies = yield* AWS.Transcribe.ListMedicalVocabularies();
 *
 * // runtime
 * const { Vocabularies } = yield* listMedicalVocabularies({ MaxResults: 10 });
 * ```
 *
 * @binding
 */
export interface ListMedicalVocabularies extends Binding.Service<
  ListMedicalVocabularies,
  "AWS.Transcribe.ListMedicalVocabularies",
  () => Effect.Effect<
    (
      request?: transcribe.ListMedicalVocabulariesRequest,
    ) => Effect.Effect<
      transcribe.ListMedicalVocabulariesResponse,
      transcribe.ListMedicalVocabulariesError
    >
  >
> {}
export const ListMedicalVocabularies = Binding.Service<ListMedicalVocabularies>(
  "AWS.Transcribe.ListMedicalVocabularies",
);
