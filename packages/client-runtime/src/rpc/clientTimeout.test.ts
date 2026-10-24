import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { EnvironmentId, ScheduledTaskId, WS_METHODS } from "@t3tools/contracts";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { RpcPermissionGuard, requestGuarded } from "./client.ts";
import { REQUEST_TIMEOUT } from "./deadlines.ts";
import type { RpcSession } from "./session.ts";

const env = EnvironmentId.make("target");

const supervisorWith = (session: RpcSession) =>
  Effect.gen(function* () {
    return {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
  });

/** The session's command tracker, recording that a command started and ended. */
const trackCommand = () => ({ release: () => {} });

/** The permission guard the shared command boundary installs; it allows here. */
const allowAll = {
  authorize: () => Effect.void,
};

/** A server that accepts the request and never answers it. */
const hangingSession = {
  client: {
    [WS_METHODS.scheduledTasksDelete]: () => Effect.never,
  },
  trackCommand,
} as unknown as RpcSession;

it.effect("a request that never answers fails with a named timeout, not a hang", () =>
  Effect.gen(function* () {
    // The fiber flips the failure into a success, so joining it hands back the
    // error value itself.
    const fiber = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(
      Effect.provideService(EnvironmentSupervisor, yield* supervisorWith(hangingSession)),
      Effect.provideService(RpcPermissionGuard, allowAll),
      Effect.flip,
      Effect.forkChild({ startImmediately: true }),
    );

    // The request is still waiting: no failure yet.
    yield* TestClock.adjust("1 second");
    expect(fiber.pollUnsafe()).toBeUndefined();

    // Past the deadline it fails, and it fails with a name the UI can show.
    yield* TestClock.adjust(REQUEST_TIMEOUT);
    const failure = yield* Fiber.join(fiber);
    expect(failure._tag).toBe("EnvironmentRpcTimeoutError");
    if (failure._tag !== "EnvironmentRpcTimeoutError") {
      throw new Error(`expected a timeout, got ${failure._tag}`);
    }
    expect(failure.method).toBe(WS_METHODS.scheduledTasksDelete);
    expect(failure.environmentId).toBe(env);
    expect(failure.timeoutMs).toBe(120_000);
    expect(failure.message).toContain("did not answer");
  }),
);

it.effect("a request that answers in time succeeds", () =>
  Effect.gen(function* () {
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.succeed({ id: ScheduledTaskId.make("task") }),
      },
      trackCommand,
    } as unknown as RpcSession;

    const result = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(
      Effect.provideService(EnvironmentSupervisor, yield* supervisorWith(session)),
      Effect.provideService(RpcPermissionGuard, allowAll),
    );

    expect(result.id).toBe(ScheduledTaskId.make("task"));
  }),
);

it.effect("a request in flight is recorded, and released when it finishes", () =>
  Effect.gen(function* () {
    const tracked: string[] = [];
    const released: string[] = [];
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.succeed({ id: ScheduledTaskId.make("task") }),
      },
      trackCommand: (method: string) => {
        tracked.push(method);
        return {
          release: () => {
            released.push(method);
          },
        };
      },
    } as unknown as RpcSession;

    yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(
      Effect.provideService(EnvironmentSupervisor, yield* supervisorWith(session)),
      Effect.provideService(RpcPermissionGuard, allowAll),
    );

    expect(tracked).toEqual([WS_METHODS.scheduledTasksDelete]);
    expect(released).toEqual([WS_METHODS.scheduledTasksDelete]);
  }),
);

it.effect("a request that times out still releases its tracker entry", () =>
  Effect.gen(function* () {
    const released: string[] = [];
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () => Effect.never,
      },
      trackCommand: (method: string) => ({
        release: () => {
          released.push(method);
        },
      }),
    } as unknown as RpcSession;

    const fiber = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(
      Effect.provideService(EnvironmentSupervisor, yield* supervisorWith(session)),
      Effect.provideService(RpcPermissionGuard, allowAll),
      Effect.flip,
      Effect.forkChild({ startImmediately: true }),
    );

    yield* TestClock.adjust(REQUEST_TIMEOUT);
    yield* Fiber.join(fiber);

    // A failed request must not leave a phantom command outstanding, or the
    // tracker would report a stall that nothing is waiting for.
    expect(released).toEqual([WS_METHODS.scheduledTasksDelete]);
  }),
);
