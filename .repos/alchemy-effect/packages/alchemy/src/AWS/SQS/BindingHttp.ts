import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isInstance } from "../EC2/Instance.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";

/**
 * Shared scaffolding for AWS SQS HTTP bindings.
 *
 * NOT exported from `index.ts` — every near-identical `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of
 * the builders below. Everything except the operation, the IAM action list,
 * and the injected identifier is boilerplate. Genuinely-different bindings
 * (the batched `QueueSink`, the dual-queue `StartMessageMoveTask`) stay
 * bespoke.
 */

const grantOnQueue = (tag: string, queue: Queue, actions: readonly string[]) =>
  Effect.gen(function* () {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (isBindingHost(host) || isInstance(host)) {
        yield* host.bind`Allow(${host}, ${tag}(${queue}))`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [...actions],
              Resource: [Output.interpolate`${queue.queueArn}`],
            },
          ],
        });
      }
    }
  });

/**
 * Build the impl Effect for a queue-scoped operation whose request carries
 * the queue identity as `QueueUrl` (`SendMessage`, `ReceiveMessage`,
 * `PurgeQueue`, …): the runtime callable injects the bound {@link Queue}'s
 * URL and the deploy-time half grants `actions` on the queue's ARN.
 */
export const makeQueueUrlHttpBinding = <
  I extends { QueueUrl?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SQS.SendMessage`. */
  tag: string;
  /** The distilled operation; the queue URL is injected as `QueueUrl`. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the queue ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      yield* grantOnQueue(options.tag, queue, options.actions);
      return Effect.fn(`${options.tag}(${queue.LogicalId})`)(function* (
        request?: Omit<I, "QueueUrl">,
      ) {
        return yield* op({
          ...request,
          QueueUrl: yield* QueueUrl,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a dead-letter-queue-scoped message-move-task
 * operation whose request carries the queue identity as `SourceArn`
 * (`ListMessageMoveTasks`): the runtime callable injects the bound
 * {@link Queue}'s ARN and the deploy-time half grants `actions` on it.
 */
export const makeQueueArnHttpBinding = <
  I extends { SourceArn?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SQS.ListMessageMoveTasks`. */
  tag: string;
  /** The distilled operation; the queue ARN is injected as `SourceArn`. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the queue ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (queue: Queue) {
      const SourceArn = yield* queue.queueArn;
      yield* grantOnQueue(options.tag, queue, options.actions);
      return Effect.fn(`${options.tag}(${queue.LogicalId})`)(function* (
        request?: Omit<I, "SourceArn">,
      ) {
        return yield* op({
          ...request,
          SourceArn: yield* SourceArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a queue-scoped operation whose request carries
 * no queue identity at all (`CancelMessageMoveTask`): the runtime callable
 * passes the caller's request through unchanged while the deploy-time half
 * still grants `actions` on the bound {@link Queue}'s ARN.
 */
export const makeQueueGrantHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SQS.CancelMessageMoveTask`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the queue ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (queue: Queue) {
      yield* grantOnQueue(options.tag, queue, options.actions);
      return Effect.fn(`${options.tag}(${queue.LogicalId})`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });
