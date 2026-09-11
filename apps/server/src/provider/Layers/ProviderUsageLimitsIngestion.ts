/**
 * V2 drivers fold live account usage events directly into their managed
 * snapshots. Retained as an empty layer for the shared server composition.
 */
import * as Layer from "effect/Layer";

export const ProviderUsageLimitsIngestionLive = Layer.empty;
