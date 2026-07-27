import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface ListStreamConsumersRequest extends Omit<
  Kinesis.ListStreamConsumersInput,
  "StreamARN"
> {}

/**
 * Runtime binding for `kinesis:ListStreamConsumers`.
 *
 * Bind this operation to a `Stream` to enumerate the enhanced fan-out
 * consumers registered on it — the stream ARN is injected automatically.
 * Provide the implementation with
 * `Effect.provide(AWS.Kinesis.ListStreamConsumersHttp)`.
 * @binding
 * @section Enhanced Fan-Out
 * @example List Registered Consumers
 * ```typescript
 * // init
 * const listStreamConsumers = yield* AWS.Kinesis.ListStreamConsumers(stream);
 *
 * // runtime
 * const result = yield* listStreamConsumers();
 * const names = (result.Consumers ?? []).map((c) => c.ConsumerName);
 * ```
 */
export interface ListStreamConsumers extends Binding.Service<
  ListStreamConsumers,
  "AWS.Kinesis.ListStreamConsumers",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: ListStreamConsumersRequest,
    ) => Effect.Effect<
      Kinesis.ListStreamConsumersOutput,
      Kinesis.ListStreamConsumersError
    >
  >
> {}

export const ListStreamConsumers = Binding.Service<ListStreamConsumers>(
  "AWS.Kinesis.ListStreamConsumers",
);
