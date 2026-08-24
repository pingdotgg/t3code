import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:ListLanguageModels` — list the custom language models in the account.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListLanguageModels` on `*`.
 *
 * @binding
 * @section Custom Language Models
 * @example List Custom Language Models
 * ```typescript
 * // init
 * const listLanguageModels = yield* AWS.Transcribe.ListLanguageModels();
 *
 * // runtime
 * const { Models } = yield* listLanguageModels({ MaxResults: 10 });
 * ```
 */
export interface ListLanguageModels extends Binding.Service<
  ListLanguageModels,
  "AWS.Transcribe.ListLanguageModels",
  () => Effect.Effect<
    (
      request?: transcribe.ListLanguageModelsRequest,
    ) => Effect.Effect<
      transcribe.ListLanguageModelsResponse,
      transcribe.ListLanguageModelsError
    >
  >
> {}
export const ListLanguageModels = Binding.Service<ListLanguageModels>(
  "AWS.Transcribe.ListLanguageModels",
);
