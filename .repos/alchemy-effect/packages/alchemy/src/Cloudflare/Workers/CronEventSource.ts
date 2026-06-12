import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { FunctionContext } from "../../Serverless/Function.ts";
import { isWorker, isWorkerEvent } from "./Worker.ts";

/**
 * Subscribe to Cloudflare Cron Triggers with an Effect handler.
 *
 * This wires both pieces of a scheduled Worker:
 *
 * - **Runtime**: registers a `scheduled` listener on the Worker.
 * - **Deploy-time**: attaches the cron expression to the host Worker.
 *
 * @example
 * ```typescript
 * yield* Cloudflare.cron("0 12 * * *").subscribe((controller) =>
 *   Effect.log(`scheduled at ${controller.scheduledTime}`),
 * );
 * ```
 */
export const cron = (expression: string) => ({
  subscribe: <Req = never>(
    process: (
      controller: cf.ScheduledController,
    ) => Effect.Effect<void, unknown, Req>,
  ) => CronEventSource.use((source) => source(expression, process)),
});

export type CronEventSourceService = <Req = never>(
  expression: string,
  process: (
    controller: cf.ScheduledController,
  ) => Effect.Effect<void, unknown, Req>,
) => Effect.Effect<void, never, never>;

export class CronEventSource extends Context.Service<
  CronEventSource,
  CronEventSourceService
>()("Cloudflare.Workers.CronEventSource") {}

export class CronEventSourcePolicy extends Binding.Policy<
  CronEventSourcePolicy,
  (expression: string) => Effect.Effect<void>
>()("Cloudflare.Workers.CronEventSource") {}

export const CronEventSourcePolicyLive = CronEventSourcePolicy.layer.succeed(
  Effect.fnUntraced(function* (host: ResourceLike, expression: string) {
    if (isWorker(host)) {
      yield* host.bind(`Cron(${expression})`, {
        crons: [expression],
      });
    } else {
      return yield* Effect.die(
        `Cloudflare.cron(...).subscribe(...) is only supported on ` +
          `Cloudflare.Worker hosts (got '${host.Type}').`,
      );
    }
  }),
);

export const CronEventSourceLive = Layer.effect(
  CronEventSource,
  Effect.gen(function* () {
    const policy = yield* CronEventSourcePolicy;
    return Effect.fn(function* <Req>(
      expression: string,
      process: (
        controller: cf.ScheduledController,
      ) => Effect.Effect<void, unknown, Req>,
    ) {
      yield* policy(expression);

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
