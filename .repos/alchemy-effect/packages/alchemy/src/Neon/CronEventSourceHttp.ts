import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as Namespace from "../Namespace.ts";
import { ProviderModePolicy } from "../ProviderMode.ts";
import { Function } from "./Function.ts";
import { FunctionRequest } from "./FunctionEnvironment.ts";
import { FunctionTrigger } from "./FunctionTrigger.ts";
import {
  CronEventSource,
  type CronEventSourceProps,
  type CronEventSourceService,
} from "./CronEventSource.ts";
import {
  decodeFunctionTriggerEvent,
  type CronEvent,
} from "./FunctionTriggerEvent.ts";

/**
 * Neon Function HTTP schedule dispatch and deployment wiring.
 *
 * ### Subscribe to a schedule
 * **Example:** Provide the subscription implementation
 * ```typescript
 * const application = Effect.gen(function* () {
 *   yield* Neon.CronEventSource("Nightly", { cron: "0 2 * * *" }, event =>
 *     Effect.log(event.invocationId),
 *   );
 *   return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 * }).pipe(Effect.provide(Neon.CronEventSourceHttp));
 * ```
 *
 * @layer
 * @product Function
 * @provides Neon.CronEventSource
 */
export const CronEventSourceHttp = Layer.effect(
  CronEventSource,
  Effect.gen(function* () {
    const host = yield* Function;
    const Trigger = yield* FunctionTrigger;
    return Effect.fn(function* (
      name: string,
      props: CronEventSourceProps,
      handler: (event: CronEvent) => Effect.Effect<void, unknown>,
    ) {
      const path = `/__alchemy/neon/cron/${encodeURIComponent(name)}`;
      const triggerName = `${host.FQN}:${name}`;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const context = yield* AlchemyContext;
        const remote = yield* ProviderModePolicy;
        if (!context.dev || remote)
          yield* Namespace.push(
            host.LogicalId,
            Trigger(name, {
              function: host,
              type: "schedule",
              name: triggerName,
              schedule: { cron: props.cron },
              path,
              enabled: props.enabled,
            }),
          );
      }
      yield* host.route(
        path,
        Effect.gen(function* () {
          const event = yield* decodeFunctionTriggerEvent(
            yield* FunctionRequest,
          );
          if (
            event.trigger.type !== "schedule" ||
            event.trigger.name !== triggerName ||
            !("scheduled_at" in event.data)
          )
            return HttpServerResponse.empty({ status: 400 });
          yield* handler({
            invocationId: event.invocation_id,
            triggerId: event.trigger.id,
            name,
            scheduledAt: event.data.scheduled_at,
          }).pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 204 });
        }).pipe(
          Effect.catchTag("FunctionTriggerEventError", (error) =>
            Effect.succeed(HttpServerResponse.empty({ status: error.status })),
          ),
        ),
      );
    }) as CronEventSourceService;
  }),
);
