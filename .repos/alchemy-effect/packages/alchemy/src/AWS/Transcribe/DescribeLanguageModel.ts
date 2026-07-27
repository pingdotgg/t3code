import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:DescribeLanguageModel` — read a custom language model's training status and metadata.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:DescribeLanguageModel` on `*`.
 *
 * @binding
 * @section Custom Language Models
 * @example Describe a Custom Language Model
 * ```typescript
 * // init
 * const describeLanguageModel = yield* AWS.Transcribe.DescribeLanguageModel();
 *
 * // runtime
 * const { LanguageModel } = yield* describeLanguageModel({
 *   ModelName: "my-domain-model",
 * });
 * ```
 */
export interface DescribeLanguageModel extends Binding.Service<
  DescribeLanguageModel,
  "AWS.Transcribe.DescribeLanguageModel",
  () => Effect.Effect<
    (
      request: transcribe.DescribeLanguageModelRequest,
    ) => Effect.Effect<
      transcribe.DescribeLanguageModelResponse,
      transcribe.DescribeLanguageModelError
    >
  >
> {}
export const DescribeLanguageModel = Binding.Service<DescribeLanguageModel>(
  "AWS.Transcribe.DescribeLanguageModel",
);
