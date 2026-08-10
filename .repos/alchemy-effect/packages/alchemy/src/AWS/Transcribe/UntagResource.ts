import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:UntagResource` — remove tags from a Transcribe resource by ARN.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:UntagResource` on `*`.
 *
 * @binding
 * @section Tagging
 * @example Untag a Transcribe Resource
 * ```typescript
 * // init
 * const untagResource = yield* AWS.Transcribe.UntagResource();
 *
 * // runtime
 * yield* untagResource({
 *   ResourceArn: "arn:aws:transcribe:us-east-1:123456789012:vocabulary/tenant-123",
 *   TagKeys: ["tenant"],
 * });
 * ```
 */
export interface UntagResource extends Binding.Service<
  UntagResource,
  "AWS.Transcribe.UntagResource",
  () => Effect.Effect<
    (
      request: transcribe.UntagResourceRequest,
    ) => Effect.Effect<
      transcribe.UntagResourceResponse,
      transcribe.UntagResourceError
    >
  >
> {}
export const UntagResource = Binding.Service<UntagResource>(
  "AWS.Transcribe.UntagResource",
);
