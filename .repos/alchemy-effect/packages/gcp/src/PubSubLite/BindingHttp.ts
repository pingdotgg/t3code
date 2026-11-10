import { Credentials } from "@distilled.cloud/gcp/Credentials";
import type { GcpOpContext } from "@distilled.cloud/gcp/pubsublite_v1";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor, type BindingIam } from "../HttpBinding.ts";
import type { AdminReservation } from "./AdminReservation.ts";
import type { AdminSubscription } from "./AdminSubscription.ts";
import type { AdminTopic } from "./AdminTopic.ts";

type Op<I, A, E> = Effect.Effect<(input: I) => Effect.Effect<A, E>, never, GcpOpContext>;

/**
 * Shared HTTP scaffolding for Pub/Sub Lite bindings.
 * NOT exported from index.ts.
 *
 * Distilled ops are `OperationMethod`s: yield them once at Layer
 * construction (after providing Credentials + HttpClient) so the inner
 * runtime Effect is `Effect<A, E>` and does not leak `GcpOpContext`.
 */
export const makeReservationHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: Op<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* options.operation as Effect.Effect<
      (input: I) => Effect.Effect<A, E>,
      never,
      Credentials | HttpClient.HttpClient
    >;
    return Effect.fn(function* (reservation: AdminReservation) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${reservation})`({
          iam: [grantFor(options.iam, reservation.name)],
        });
      }
      const name = yield* reservation.name;
      return Effect.fn(`${options.tag}(${reservation.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...request,
          name: yield* name,
        } as I);
      });
    });
  });

export const makeTopicNameHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: Op<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* options.operation as Effect.Effect<
      (input: I) => Effect.Effect<A, E>,
      never,
      Credentials | HttpClient.HttpClient
    >;
    return Effect.fn(function* (topic: AdminTopic) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${topic})`({
          iam: [grantFor(options.iam, topic.name)],
        });
      }
      const name = yield* topic.name;
      return Effect.fn(`${options.tag}(${topic.LogicalId})`)(function* (request?: Omit<I, "name">) {
        return yield* run({
          ...request,
          name: yield* name,
        } as I);
      });
    });
  });

export const makeTopicStatsHttpBinding = <I extends { topic: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: Op<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* options.operation as Effect.Effect<
      (input: I) => Effect.Effect<A, E>,
      never,
      Credentials | HttpClient.HttpClient
    >;
    return Effect.fn(function* (topic: AdminTopic) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${topic})`({
          iam: [grantFor(options.iam, topic.name)],
        });
      }
      const name = yield* topic.name;
      return Effect.fn(`${options.tag}(${topic.LogicalId})`)(function* (
        request?: Omit<I, "topic">,
      ) {
        return yield* run({
          ...request,
          topic: yield* name,
        } as I);
      });
    });
  });

export const makeSubscriptionHttpBinding = <
  I extends { name?: string; subscription?: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  field: "name" | "subscription";
  operation: Op<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* options.operation as Effect.Effect<
      (input: I) => Effect.Effect<A, E>,
      never,
      Credentials | HttpClient.HttpClient
    >;
    return Effect.fn(function* (subscription: AdminSubscription) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${subscription})`({
          iam: [grantFor(options.iam, subscription.name)],
        });
      }
      const name = yield* subscription.name;
      return Effect.fn(`${options.tag}(${subscription.LogicalId})`)(function* (
        request?: Omit<I, "name" | "subscription">,
      ) {
        const resolved = yield* name;
        const input =
          options.field === "subscription"
            ? ({ ...request, subscription: resolved } as I)
            : ({ ...request, name: resolved } as I);
        return yield* run(input);
      });
    });
  });
