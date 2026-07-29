import type * as polly from "@distilled.cloud/aws/polly";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `polly:DescribeVoices` — list the voices available
 * for speech synthesis, optionally filtered by engine or language.
 *
 * Polly voices are account-wide, so the binding takes no arguments and
 * grants the function `polly:DescribeVoices`. Provide the implementation
 * with `Effect.provide(AWS.Polly.DescribeVoicesHttp)`.
 *
 * @binding
 * @section Discovering Voices
 * @example List US English voices
 * ```typescript
 * // init
 * const describeVoices = yield* AWS.Polly.DescribeVoices();
 *
 * // runtime
 * const result = yield* describeVoices({ LanguageCode: "en-US" });
 * const voiceIds = (result.Voices ?? []).map((voice) => voice.Id);
 * ```
 */
export interface DescribeVoices extends Binding.Service<
  DescribeVoices,
  "AWS.Polly.DescribeVoices",
  () => Effect.Effect<
    (
      request?: polly.DescribeVoicesInput,
    ) => Effect.Effect<polly.DescribeVoicesOutput, polly.DescribeVoicesError>
  >
> {}
export const DescribeVoices = Binding.Service<DescribeVoices>(
  "AWS.Polly.DescribeVoices",
);
