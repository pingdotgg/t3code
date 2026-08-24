import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:TagResource` — add tags to a Transcribe resource (jobs, vocabularies, filters, categories, or models) by ARN.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:TagResource` on `*`.
 *
 * @binding
 * @section Tagging
 * @example Tag a Transcribe Resource
 * ```typescript
 * // init
 * const tagResource = yield* AWS.Transcribe.TagResource();
 *
 * // runtime
 * yield* tagResource({
 *   ResourceArn: "arn:aws:transcribe:us-east-1:123456789012:vocabulary/tenant-123",
 *   Tags: [{ Key: "tenant", Value: "123" }],
 * });
 * ```
 */
export interface TagResource extends Binding.Service<
  TagResource,
  "AWS.Transcribe.TagResource",
  () => Effect.Effect<
    (
      request: transcribe.TagResourceRequest,
    ) => Effect.Effect<
      transcribe.TagResourceResponse,
      transcribe.TagResourceError
    >
  >
> {}
export const TagResource = Binding.Service<TagResource>(
  "AWS.Transcribe.TagResource",
);
