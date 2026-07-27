import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { DeliveryStream } from "./DeliveryStream.ts";

/**
 * Shared scaffolding for AWS Firehose HTTP bindings.
 *
 * NOT exported from `index.ts` — every near-identical `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of
 * the builders below. Everything except the operation, the IAM action list,
 * and the granted ARNs is boilerplate. Genuinely-different bindings (the
 * batched `DeliveryStreamSink`) stay bespoke.
 */

/**
 * Build the impl Effect for a delivery-stream-scoped operation
 * (`PutRecord`, `PutRecordBatch`): the runtime callable injects the bound
 * {@link DeliveryStream}'s physical name as `DeliveryStreamName` and the
 * deploy-time half grants `actions` on the delivery stream's ARN.
 */
export const makeDeliveryStreamHttpBinding = <
  I extends { DeliveryStreamName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Firehose.PutRecord`. */
  tag: string;
  /** The distilled operation; `DeliveryStreamName` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the delivery stream ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (deliveryStream: DeliveryStream) {
      const DeliveryStreamName = yield* deliveryStream.deliveryStreamName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${deliveryStream}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`${deliveryStream.deliveryStreamArn}`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${deliveryStream.LogicalId})`)(
        function* (request: Omit<I, "DeliveryStreamName">) {
          return yield* op({
            ...request,
            DeliveryStreamName: yield* DeliveryStreamName,
          } as I);
        },
      );
    });
  });

/**
 * Build the impl Effect for an account-level operation
 * (`ListDeliveryStreams`): the runtime callable passes the caller's request
 * through unchanged and the deploy-time half grants `actions` on `*`
 * (these Firehose actions do not support resource-level permissions).
 */
export const makeFirehoseAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Firehose.ListDeliveryStreams`. */
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
