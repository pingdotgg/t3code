import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  createScheduleRoute,
  createScheduleRouteId,
  isScheduleEvent,
  ScheduleEventSource as SchedulerScheduleEventSource,
  type ScheduleDescriptor,
  type ScheduleEvent,
  type ScheduleEventSourceService,
} from "../Scheduler/ScheduleEventSource.ts";
import * as Lambda from "./Function.ts";

/**
 * Lambda runtime implementation for `AWS.Scheduler.consumeSchedule(...)` —
 * the "cron handler" DX where a Lambda consumes its own EventBridge Scheduler
 * invocations.
 *
 * This layer does two things:
 *
 * 1. At deploy time it creates the backing `Schedule` targeting the current
 *    Lambda function, plus the synthesized execution role that allows
 *    EventBridge Scheduler to invoke it.
 * 2. At runtime it matches incoming Lambda events against the schedule's
 *    typed envelope (`isScheduleEvent` + the stable route id) and dispatches
 *    them to the supplied handler.
 * @binding
 * @section Consuming Scheduled Invocations
 * @example Run A Handler Every 5 Minutes
 * ```typescript
 * yield* AWS.Scheduler.consumeSchedule(
 *   AWS.Scheduler.every("5 minutes"),
 *   (event) => Effect.log(`fired at ${event.scheduledTime}`),
 * );
 * ```
 *
 * @example Nightly Cron With An Explicit Route Id
 * ```typescript
 * yield* AWS.Scheduler.consumeSchedule(
 *   "NightlyCleanup",
 *   AWS.Scheduler.cron("cron(0 3 * * ? *)"),
 *   (event) => Effect.log(`cleanup ${event.executionId}`),
 * );
 * ```
 */
export const ScheduleEventSource = Layer.effect(
  SchedulerScheduleEventSource,
  Effect.gen(function* () {
    const host = yield* Lambda.Function;

    return Effect.fn(function* <Req = never>(
      descriptor: ScheduleDescriptor,
      process: (event: ScheduleEvent) => Effect.Effect<void, never, Req>,
    ) {
      // Stable route id — computed identically at deploy time (names the
      // backing Schedule + role) and at runtime (matches incoming events).
      const routeId = yield* Effect.sync(() =>
        createScheduleRouteId(descriptor, host),
      );

      // Deploy-time: create the backing Schedule + execution role targeting
      // this function. Skipped once running inside the deployed Function (the
      // global guard), where the only work is registering the runtime handler
      // below.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* createScheduleRoute(routeId, descriptor, host).pipe(
          Effect.asVoid,
        );
      }

      yield* host.listen(
        Effect.sync(() => (event: any) => {
          if (isScheduleEvent(event) && event.scheduleId === routeId) {
            return process(event).pipe(Effect.orDie);
          }
        }),
      );
    }) as ScheduleEventSourceService;
  }),
);
