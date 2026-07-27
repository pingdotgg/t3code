import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Stream } from "./Stream.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

/**
 * Shared scaffolding for AWS Kinesis HTTP bindings.
 *
 * NOT exported from `index.ts` — every near-identical `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of
 * the builders below. Everything except the operation, the IAM action list,
 * and the injected identifier is boilerplate. Genuinely-different bindings
 * (the batched `StreamSink`, the `Stream | StreamConsumer` polymorphic
 * `ListTagsForResource`) stay bespoke.
 */

/**
 * Build the impl Effect for an account-level operation (`ListStreams`,
 * `DescribeLimits`, `DescribeAccountSettings`): the runtime callable passes
 * the caller's request through unchanged and the deploy-time half grants
 * `actions` on `*` (these Kinesis actions do not support resource-level
 * permissions).
 */
export const makeKinesisAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Kinesis.ListStreams`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });

/**
 * Build the impl Effect for a stream-scoped operation: the runtime callable
 * injects the bound {@link Stream}'s identity under `key` (`StreamARN` for
 * the describe/shard APIs, `StreamName` for the producer APIs, `ResourceARN`
 * for the policy APIs) and the deploy-time half grants `actions` on the
 * stream's ARN.
 */
export const makeStreamHttpBinding = <
  K extends "StreamARN" | "StreamName" | "ResourceARN",
  I extends { [P in K]?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Kinesis.DescribeStream`. */
  tag: string;
  /** The distilled operation; the stream identity is injected under `key`. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the stream ARN. */
  actions: readonly string[];
  /** The request field the stream identity is injected under. */
  key: K;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (stream: Stream) {
      const identity = yield* options.key === "StreamName"
        ? stream.streamName
        : stream.streamArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${stream}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [stream.streamArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${stream.LogicalId})`)(function* (
        request?: Omit<I, K>,
      ) {
        return yield* op({
          ...request,
          [options.key]: yield* identity,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a consumer-scoped operation
 * (`DescribeStreamConsumer`, `SubscribeToShard`): the runtime callable
 * injects the bound {@link StreamConsumer}'s ARN as `ConsumerARN` and the
 * deploy-time half grants `actions` on the consumer ARN.
 */
export const makeConsumerHttpBinding = <
  I extends { ConsumerARN?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Kinesis.SubscribeToShard`. */
  tag: string;
  /** The distilled operation; `ConsumerARN` is injected from the consumer. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the consumer ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (consumer: StreamConsumer) {
      const ConsumerARN = yield* consumer.consumerArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${consumer}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [consumer.consumerArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${consumer.LogicalId})`)(function* (
        request?: Omit<I, "ConsumerARN">,
      ) {
        return yield* op({
          ...request,
          ConsumerARN: yield* ConsumerARN,
        } as I);
      });
    });
  });
