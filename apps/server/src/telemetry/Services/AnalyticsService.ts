/**
 * AnalyticsService - Anonymous telemetry capture contract.
 *
 * Provides a best-effort event API for runtime telemetry and a strict
 * `captureImmediate` method for call sites that need explicit error handling.
 *
 * @module AnalyticsService
 */
import { Effect, Layer, Context } from "effect";

export interface AnalyticsServiceShape {
  /**
   * Capture an event immediately; returns typed failure when capture fails.
   */
  readonly record: (
    event: string,
    properties?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void, never>;

  /**
   * Flush queued telemetry.
   */
  readonly flush: Effect.Effect<void, never>;
}

export class AnalyticsService extends Context.Service<AnalyticsService, AnalyticsServiceShape>()(
  "t3/telemetry/Services/AnalyticsService",
) {
  static readonly layerTest = Layer.succeed(AnalyticsService, {
    record: () => Effect.void,
    flush: Effect.void,
  });
}
