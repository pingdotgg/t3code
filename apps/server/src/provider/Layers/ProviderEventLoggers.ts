/**
 * ProviderEventLoggers — single observability service that owns the shared
 * provider event log store and exposes its two runtime views:
 *
 *   - `native`    — provider-protocol events as the SDK emits them, written
 *                   from inside each `<X>Adapter` factory.
 *   - `canonical` — runtime events after `ProviderService` has normalized
 *                   them onto `ProviderRuntimeEvent`.
 *
 * Why a service tag and not constructor options?
 *
 *   - Adapters are now constructed *inside* drivers (`<X>Driver.create()`),
 *     not at the boot Layer. There is no longer a single `make<X>AdapterLive(options)`
 *     call site where we can hand an `EventNdjsonLogger` in by hand.
 *   - Multiple driver instances per kind (`codex_personal`, `codex_work`)
 *     must share one underlying log store — opening N writers against the
 *     same rotating file would race the rotation logic. Owning the loggers on
 *     a single tag keeps that invariant intact.
 *   - Tests can swap one (or both) loggers with in-memory recorders by
 *     `Layer.succeed(ProviderEventLoggers, { native, canonical })` instead of
 *     juggling per-Layer option threading.
 *
 * Both fields are optional because observability must not prevent startup.
 *
 * @module provider/Layers/ProviderEventLoggers
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import * as EventNdjsonLogger from "./EventNdjsonLogger.ts";

export interface ProviderEventLoggersShape {
  readonly native: EventNdjsonLogger.EventNdjsonLogger | undefined;
  readonly canonical: EventNdjsonLogger.EventNdjsonLogger | undefined;
}

/**
 * Shared logger pair for native + canonical provider event streams.
 *
 * Service value is intentionally a struct of two optional loggers rather
 * than two parallel tags. Construction site is one place
 * (`layer`); consumers (drivers, `ProviderService`) read one tag and pluck the
 * field they need.
 */
export class ProviderEventLoggers extends Context.Service<
  ProviderEventLoggers,
  ProviderEventLoggersShape
>()("t3/provider/Layers/ProviderEventLoggers") {}

/**
 * Constant value used by tests / boot layers that want to opt out of native
 * + canonical logging entirely. Keeps the tag non-optional in the type
 * system while letting the runtime treat absence as a no-op.
 */
export const NoOpProviderEventLoggers: ProviderEventLoggersShape = {
  native: undefined,
  canonical: undefined,
};

/**
 * Builds both stream views over one shared store. Setup failures are logged
 * and downgraded to the no-op service so diagnostics never block startup.
 */
export const make = Effect.gen(function* () {
  const { providerEventLogPath } = yield* ServerConfig;
  const attribution = yield* ResourceAttribution.ResourceAttribution;
  const store = yield* EventNdjsonLogger.makeEventNdjsonLogStore(providerEventLogPath, {
    attribution,
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(error.message, { error }).pipe(
        Effect.annotateLogs({ scope: "provider-observability" }),
        Effect.as<EventNdjsonLogger.EventNdjsonLogStore | undefined>(undefined),
      ),
    ),
  );

  if (!store) {
    return ProviderEventLoggers.of(NoOpProviderEventLoggers);
  }

  yield* Effect.addFinalizer(() => store.close());
  return ProviderEventLoggers.of({
    native: store.logger("native"),
    canonical: store.logger("canonical"),
  });
});

export const layer = Layer.effect(ProviderEventLoggers, make);
