import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AnalyticsService } from "./AnalyticsService.ts";

/** Fork: records nothing, so feedback reports stay saved locally as not sent. */
export const layer = Layer.succeed(
  AnalyticsService,
  AnalyticsService.of({
    record: Effect.fn("ForkNoAnalytics.record")(() => Effect.succeed(false)),
    flush: Effect.void,
    recordOwners: Effect.fn("ForkNoAnalytics.recordOwners")(() => Effect.void),
  }),
);
