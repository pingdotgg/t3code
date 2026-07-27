import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:ListTagsForResource` — list the tags on a Transcribe resource by ARN.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListTagsForResource` on `*`.
 *
 * @binding
 * @section Tagging
 * @example List Tags on a Transcribe Resource
 * ```typescript
 * // init
 * const listTagsForResource = yield* AWS.Transcribe.ListTagsForResource();
 *
 * // runtime
 * const { Tags } = yield* listTagsForResource({
 *   ResourceArn: "arn:aws:transcribe:us-east-1:123456789012:vocabulary/tenant-123",
 * });
 * ```
 */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.Transcribe.ListTagsForResource",
  () => Effect.Effect<
    (
      request: transcribe.ListTagsForResourceRequest,
    ) => Effect.Effect<
      transcribe.ListTagsForResourceResponse,
      transcribe.ListTagsForResourceError
    >
  >
> {}
export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.Transcribe.ListTagsForResource",
);
