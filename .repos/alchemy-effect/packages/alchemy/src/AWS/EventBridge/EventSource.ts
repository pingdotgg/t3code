import type * as lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "../ECS/Cluster.ts";
import type { Function as LambdaFunction } from "../Lambda/Function.ts";
import type { Queue } from "../SQS/Queue.ts";
import type { EventBus } from "./EventBus.ts";
import type { RuleProps } from "./Rule.ts";
import {
  toEcsTask as createEcsTaskRoute,
  type EcsRouteTargetProps,
} from "./ToEcsTask.ts";
import {
  toLambda as createLambdaRoute,
  type LambdaRouteTargetProps,
} from "./ToLambda.ts";
import {
  toQueue as createQueueRoute,
  type QueueRouteTargetProps,
} from "./ToQueue.ts";

export type EventPattern = Record<string, any>;
export type EventRecord<Detail = unknown> = lambda.EventBridgeEvent<
  string,
  Detail
>;

export interface EventRouteProps extends Pick<
  RuleProps,
  "description" | "state"
> {}

export interface SubscribeProps extends EventRouteProps {}

export type { EcsRouteTargetProps } from "./ToEcsTask.ts";
export type { LambdaRouteTargetProps } from "./ToLambda.ts";
export type { QueueRouteTargetProps } from "./ToQueue.ts";

interface EventDescriptor {
  id?: string;
  bus?: EventBus;
  pattern: EventPattern;
  props?: EventRouteProps;
}

export class EventSource extends Binding.Service<
  EventSource,
  EventSourceService
>()("AWS.EventBridge.EventSource") {}

export type EventSourceService = <
  Detail = unknown,
  StreamReq = never,
  Req = never,
>(
  descriptor: EventDescriptor,
  process: (
    events: Stream.Stream<EventRecord<Detail>, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

export const events = (...args: any[]) => {
  const descriptor = parseEventDescriptor(args);

  return {
    subscribe: <Detail = unknown, Req = never, StreamReq = never>(
      process: (
        events: Stream.Stream<EventRecord<Detail>, never, StreamReq>,
      ) => Effect.Effect<void, never, Req>,
    ) => EventSource.use((source) => source(descriptor, process)),
    toLambda: (fn: LambdaFunction, props: LambdaRouteTargetProps = {}) =>
      createLambdaRoute(descriptor, fn, props),
    toQueue: (queue: Queue, props: QueueRouteTargetProps = {}) =>
      createQueueRoute(descriptor, queue, props),
    toEcsTask: (cluster: Cluster, props: EcsRouteTargetProps) =>
      createEcsTaskRoute(descriptor, cluster, props),
  };
};

export const matchesEventPattern = (
  pattern: EventPattern,
  event: Record<string, any>,
): boolean =>
  Object.entries(pattern).every(([key, expected]) =>
    matchValue(expected, event[key]),
  );

const matchValue = (expected: any, actual: any): boolean => {
  if (Array.isArray(expected)) {
    return expected.some((value) => matchValue(value, actual));
  }

  if (expected && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") {
      return false;
    }

    return Object.entries(expected).every(([key, value]) =>
      matchValue(value, actual[key]),
    );
  }

  return actual === expected;
};

const parseEventDescriptor = (args: any[]): EventDescriptor => {
  if (typeof args[0] === "string") {
    if (isEventBus(args[1])) {
      return {
        id: args[0],
        bus: args[1],
        pattern: args[2],
        props: args[3],
      };
    }

    return {
      id: args[0],
      pattern: args[1],
      props: args[2],
    };
  }

  if (isEventBus(args[0])) {
    return {
      bus: args[0],
      pattern: args[1],
      props: args[2],
    };
  }

  return {
    pattern: args[0],
    props: args[1],
  };
};

const isEventBus = (value: any): value is EventBus =>
  value &&
  typeof value === "object" &&
  "Type" in value &&
  value.Type === "AWS.EventBridge.EventBus";
