// Hyakki collects no analytics. The service keeps its shape so callers stay unchanged, but it
// never stores, batches or sends an event, and it reaches no network endpoint.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { TelemetryOwner } from "./Identify.ts";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Always false: no event is ever queued or sent. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
      options?: { readonly anonymous?: boolean },
    ) => Effect.Effect<boolean>;

    readonly flush: Effect.Effect<void>;

    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

/** @public */
export const make = Effect.succeed(
  AnalyticsService.of({
    record: Effect.fn("AnalyticsService.record")(function* () {
      return false;
    }),
    flush: Effect.void,
    recordOwners: Effect.fn("AnalyticsService.recordOwners")(function* () {}),
  }),
);

export const layer = Layer.effect(AnalyticsService, make);
