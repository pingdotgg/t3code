import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:DeleteLanguageModel` — delete a custom language model.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:DeleteLanguageModel` on `*`.
 *
 * @binding
 * @section Custom Language Models
 * @example Delete a Custom Language Model
 * ```typescript
 * // init
 * const deleteLanguageModel = yield* AWS.Transcribe.DeleteLanguageModel();
 *
 * // runtime
 * yield* deleteLanguageModel({ ModelName: "my-domain-model" });
 * ```
 */
export interface DeleteLanguageModel extends Binding.Service<
  DeleteLanguageModel,
  "AWS.Transcribe.DeleteLanguageModel",
  () => Effect.Effect<
    (
      request: transcribe.DeleteLanguageModelRequest,
    ) => Effect.Effect<
      transcribe.DeleteLanguageModelResponse,
      transcribe.DeleteLanguageModelError
    >
  >
> {}
export const DeleteLanguageModel = Binding.Service<DeleteLanguageModel>(
  "AWS.Transcribe.DeleteLanguageModel",
);
