import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { CronEvent } from "./FunctionTriggerEvent.ts";

export interface CronEventSourceProps {
  /** Numeric five-field UTC cron expression. */ cron: string;
  /** Enable future delivery. @default true */ enabled?: boolean;
}
export type CronEventSourceService = <R = never>(
  name: string,
  props: CronEventSourceProps,
  handler: (event: CronEvent) => Effect.Effect<void, unknown, R>,
) => Effect.Effect<void, never, Exclude<R, RuntimeContext | Scope>>;
/**
 * Register a typed POST handler and create its tracked FunctionTrigger automatically.
 * Provide CronEventSourceHttp on the Function initialization Effect. Handler failures
 * remain non-success HTTP responses; delivery is not a native `scheduled` event
 * or an exactly-once guarantee. Local development does not run a cron scheduler.
 *
 * ### Register a Schedule
 * **Example:** Process a scheduled occurrence
 * ```typescript
 * yield* Neon.CronEventSource("Nightly", { cron: "0 2 * * *" }, event => Effect.log(event.invocationId));
 * ```
 *
 * @binding
 * @product Function
 */
export interface CronEventSource extends Binding.Service<
  CronEventSource,
  "Neon.CronEventSource",
  CronEventSourceService
> {
  <R = never>(
    name: string,
    props: CronEventSourceProps,
    handler: (event: CronEvent) => Effect.Effect<void, unknown, R>,
  ): Effect.Effect<
    void,
    never,
    CronEventSource | Exclude<R, RuntimeContext | Scope>
  >;
}
export const CronEventSource = Binding.Service<CronEventSource>(
  "Neon.CronEventSource",
);
