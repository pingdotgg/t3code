import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:ListVocabularies` — list the custom vocabularies in the account.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListVocabularies` on `*`.
 *
 * @binding
 * @section Custom Vocabularies
 * @example List Custom Vocabularies
 * ```typescript
 * // init
 * const listVocabularies = yield* AWS.Transcribe.ListVocabularies();
 *
 * // runtime
 * const { Vocabularies } = yield* listVocabularies({ MaxResults: 10 });
 * ```
 */
export interface ListVocabularies extends Binding.Service<
  ListVocabularies,
  "AWS.Transcribe.ListVocabularies",
  () => Effect.Effect<
    (
      request?: transcribe.ListVocabulariesRequest,
    ) => Effect.Effect<
      transcribe.ListVocabulariesResponse,
      transcribe.ListVocabulariesError
    >
  >
> {}
export const ListVocabularies = Binding.Service<ListVocabularies>(
  "AWS.Transcribe.ListVocabularies",
);
