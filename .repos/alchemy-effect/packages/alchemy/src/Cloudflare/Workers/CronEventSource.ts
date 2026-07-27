import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Namespace from "../../Namespace.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { FunctionContext } from "../../Serverless/Function.ts";
import { isWorkerEvent, Worker } from "./Worker.ts";

/**
 * Subscribe to Cloudflare Cron Triggers with an Effect handler.
 *
 * A single call wires both pieces of a scheduled Worker:
 *
 * - **Deploy-time**: attaches the cron expression to the host Worker's
 *   Cron Triggers.
 * - **Runtime**: registers a `scheduled` listener that runs your Effect on
 *   each fire. The handler receives Cloudflare's `ScheduledController`,
 *   which has three members:
 *   - `controller.scheduledTime` — the fire time in milliseconds since the
 *     Unix epoch.
 *   - `controller.cron` — the cron expression that fired.
 *   - `controller.noRetry()` — opts the invocation out of Cloudflare's
 *     retry-on-failure. Only meaningful when the scheduled invocation can
 *     actually fail — see the failure & retry section below.
 *
 *   Each member has its own section below with an Effect example first and
 *   an async example second.
 *
 * Requires `CronEventSourceLive` provided on the Worker's Effect.
 *
 * **Failure & retry semantics**: a failing handler won't crash the Worker —
 * the event source catches the failure and moves on. That also means
 * Cloudflare never observes a failed invocation, so its platform-level
 * retry (and `controller.noRetry()`) never comes into play here. Express
 * retry declaratively with `Effect.retry` inside the handler, and log or
 * report errors if you need visibility into failed runs. In async Workers
 * the opposite holds: a `scheduled` handler that throws (or rejects) marks
 * the invocation failed and Cloudflare may retry it — call
 * `controller.noRetry()` before rethrowing to suppress that.
 *
 * Async (non-Effect) Workers don't use `cron` — they attach schedules with
 * the Worker's `crons` prop and export their own `scheduled` handler from
 * the entry module (each section below includes the async variant). Pass
 * `crons: []` to remove all Cron Triggers from a Worker.
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 *
 * @section Declare a schedule
 * @example Effect-native Worker (recommended)
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default Cloudflare.Worker(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Cloudflare.Workers.cron("0 12 * * *", () =>
 *       Effect.log("cron fired"),
 *     );
 *
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive)),
 * );
 * ```
 *
 * @example Async Worker — `crons` prop + exported `scheduled` handler
 * ```typescript
 * // alchemy.run.ts — attach the cron expressions at deploy time
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   crons: ["0 12 * * *"],
 * });
 *
 * // src/worker.ts — the entry module handles the fires itself
 * export default {
 *   async scheduled(controller: ScheduledController) {
 *     console.log("cron fired");
 *   },
 * };
 * ```
 *
 * @section `controller.scheduledTime` — the fire time
 * @example Effect: record each fire on a Durable Object
 * ```typescript
 * export default class Worker extends Cloudflare.Worker<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* CronCounter;
 *
 *     yield* Cloudflare.Workers.cron("0 * * * *", (controller) =>
 *       counters.getByName("default").record(controller.scheduledTime),
 *     );
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { times } = yield* counters.getByName("default").snapshot();
 *         return yield* HttpServerResponse.json({ times });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive)),
 * ) {}
 * ```
 *
 * @example Async: use the fire time as an idempotency key
 * ```typescript
 * // scheduledTime is the time the fire was *scheduled* for (not when it
 * // ran), so it is stable across retries of the same fire — a natural
 * // idempotency key for at-most-once side effects.
 * export default {
 *   async scheduled(controller: ScheduledController, env: WorkerEnv) {
 *     const key = `run:${controller.scheduledTime}`;
 *     if (await env.RUNS.get(key)) return;
 *     await syncFeeds();
 *     await env.RUNS.put(key, "done");
 *   },
 * };
 * ```
 *
 * @section `controller.cron` — dispatch multiple schedules
 * @example Effect: one handler per expression
 * ```typescript
 * // Each handler only runs for fires of its own expression — the listener
 * // checks controller.cron, so a midnight fire never runs the hourly handler.
 * yield* Cloudflare.Workers.cron("0 * * * *", () => syncFeeds);
 * yield* Cloudflare.Workers.cron("0 0 * * *", () => purgeExpired);
 * ```
 *
 * @example Async: switch on `controller.cron`
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   crons: ["0 * * * *", "0 0 * * *"],
 * });
 *
 * // src/worker.ts — one scheduled handler receives every fire
 * export default {
 *   async scheduled(controller: ScheduledController) {
 *     switch (controller.cron) {
 *       case "0 * * * *":
 *         await syncFeeds();
 *         break;
 *       case "0 0 * * *":
 *         await purgeExpired();
 *         break;
 *     }
 *   },
 * };
 * ```
 *
 * @section `controller.noRetry()` — failure & retry control
 * @example Effect: bound retries with `Effect.retry`
 * ```typescript
 * import * as Schedule from "effect/Schedule";
 *
 * // The event source reports the invocation as successful even when the
 * // handler fails, so Cloudflare's platform retry rarely engages for Effect
 * // handlers — Effect.retry is the primary retry control. Calling
 * // controller.noRetry() once retries are exhausted defensively covers
 * // anything that can still mark the invocation failed (e.g. a failing
 * // waitUntil task).
 * yield* Cloudflare.Workers.cron("0 * * * *", (controller) =>
 *   syncFeeds.pipe(
 *     Effect.retry({ schedule: Schedule.exponential("1 second"), times: 3 }),
 *     Effect.tapError((error) =>
 *       Effect.logError("syncFeeds failed permanently", error).pipe(
 *         Effect.andThen(Effect.sync(() => controller.noRetry())),
 *       ),
 *     ),
 *   ),
 * );
 * ```
 *
 * @example Async: suppress retry for permanent failures
 * ```typescript
 * // src/worker.ts — a thrown error marks the invocation failed and
 * // Cloudflare may retry it; noRetry() opts this fire out of that.
 * export default {
 *   async scheduled(controller: ScheduledController) {
 *     try {
 *       await syncFeeds();
 *     } catch (error) {
 *       if (isPermanentFailure(error)) {
 *         controller.noRetry();
 *       }
 *       throw error; // still recorded as a failed invocation
 *     }
 *   },
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/workers/configuration/cron-triggers/
 */
export const cron = <Req = never>(
  expression: string,
  process: (
    controller: cf.ScheduledController,
  ) => Effect.Effect<void, unknown, Req>,
): Effect.Effect<void, never, CronEventSource | Exclude<Req, RuntimeContext>> =>
  CronEventSource.use((source) => source(expression, process));

export type CronEventSourceService = <Req = never>(
  expression: string,
  process: (
    controller: cf.ScheduledController,
  ) => Effect.Effect<void, unknown, Req>,
) => Effect.Effect<void, never, Exclude<Req, RuntimeContext>>;

export class CronEventSource extends Context.Service<
  CronEventSource,
  CronEventSourceService
>()("Cloudflare.Workers.CronEventSource") {}

export const CronEventSourceLive = Layer.effect(
  CronEventSource,
  Effect.gen(function* () {
    const host = yield* Worker;
    return Effect.fn(function* <Req>(
      expression: string,
      process: (
        controller: cf.ScheduledController,
      ) => Effect.Effect<void, unknown, Req>,
    ) {
      // Deploy-time: attach the cron expression to the host Worker. Skipped once
      // running inside the deployed Worker (the global guard), where the only
      // work is registering the runtime scheduled handler below. Namespaced
      // under the host so logical identity matches the previous Binding.Policy.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          host.bind(`Cron(${expression})`, {
            crons: [expression],
          }),
        );
      }

      const ctx = (yield* RuntimeContext) as unknown as FunctionContext;
      yield* ctx.listen<void, Req>((event) => {
        if (!isWorkerEvent(event) || event.type !== "scheduled") return;

        const controller = event.input as cf.ScheduledController;
        if (controller.cron !== expression) return;

        return process(controller).pipe(Effect.catchCause(() => Effect.void));
      });
    }) as CronEventSourceService;
  }),
);
