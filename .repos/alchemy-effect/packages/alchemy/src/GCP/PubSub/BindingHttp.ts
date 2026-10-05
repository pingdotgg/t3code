import * as Effect from "effect/Effect";
import { bindGcpHost } from "../Host.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";
import type { Subscription } from "./Subscription.ts";
import type { Topic } from "./Topic.ts";

/**
 * Shared HTTP scaffolding for Pub/Sub bindings.
 * NOT exported from index.ts.
 */
export const makeTopicHttpBinding = <
  I extends { topic: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (topic: Topic) {
      const name = yield* topic.name;
      yield* bindGcpHost({
        tag: options.tag,
        resource: topic,
        iam: [grantFor(options.iam, topic.name)],
      });
      return Effect.fn(`${options.tag}(${topic.LogicalId})`)(function* (
        request: Omit<I, "topic">,
      ) {
        return yield* run({
          ...request,
          topic: yield* name,
        } as I);
      });
    });
  });

export const makeSubscriptionHttpBinding = <
  I extends { subscription: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (subscription: Subscription) {
      const name = yield* subscription.name;
      yield* bindGcpHost({
        tag: options.tag,
        resource: subscription,
        iam: [grantFor(options.iam, subscription.name)],
      });
      return Effect.fn(`${options.tag}(${subscription.LogicalId})`)(function* (
        request: Omit<I, "subscription">,
      ) {
        return yield* run({
          ...request,
          subscription: yield* name,
        } as I);
      });
    });
  });
