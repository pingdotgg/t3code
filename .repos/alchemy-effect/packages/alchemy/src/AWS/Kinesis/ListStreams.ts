import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListStreamsRequest extends Kinesis.ListStreamsInput {}

/**
 * Runtime binding for `kinesis:ListStreams`.
 *
 * An account-level operation (no stream argument) that enumerates all
 * Kinesis streams in the region. Provide the implementation with
 * `Effect.provide(AWS.Kinesis.ListStreamsHttp)`.
 * @binding
 * @section Inspecting Streams
 * @example List Streams in the Region
 * ```typescript
 * // init — account-level binding takes no resource
 * const listStreams = yield* AWS.Kinesis.ListStreams();
 *
 * // runtime
 * const result = yield* listStreams();
 * yield* Effect.log(result.StreamNames);
 * ```
 */
export interface ListStreams extends Binding.Service<
  ListStreams,
  "AWS.Kinesis.ListStreams",
  () => Effect.Effect<
    (
      request?: ListStreamsRequest,
    ) => Effect.Effect<Kinesis.ListStreamsOutput, Kinesis.ListStreamsError>
  >
> {}
export const ListStreams = Binding.Service<ListStreams>(
  "AWS.Kinesis.ListStreams",
);
