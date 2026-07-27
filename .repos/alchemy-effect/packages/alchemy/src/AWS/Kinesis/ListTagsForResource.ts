import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

export type TaggableResource = Stream | StreamConsumer;

export interface ListTagsForResourceRequest extends Omit<
  Kinesis.ListTagsForResourceInput,
  "ResourceARN"
> {}

/**
 * Runtime binding for `kinesis:ListTagsForResource`.
 *
 * Bind this operation to a `Stream` or `StreamConsumer` to read its tags —
 * the resource ARN is injected automatically. Provide the implementation
 * with `Effect.provide(AWS.Kinesis.ListTagsForResourceHttp)`.
 * @binding
 * @section Inspecting Streams
 * @example Read a Stream's Tags
 * ```typescript
 * // init — works for a Stream or a StreamConsumer
 * const listTagsForResource = yield* AWS.Kinesis.ListTagsForResource(stream);
 *
 * // runtime
 * const result = yield* listTagsForResource();
 * const tags = Object.fromEntries(
 *   (result.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
 * );
 * ```
 */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.Kinesis.ListTagsForResource",
  (
    resource: TaggableResource,
  ) => Effect.Effect<
    (
      request?: ListTagsForResourceRequest,
    ) => Effect.Effect<
      Kinesis.ListTagsForResourceOutput,
      Kinesis.ListTagsForResourceError
    >
  >
> {}

export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.Kinesis.ListTagsForResource",
);
