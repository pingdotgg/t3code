/**
 * ProviderEventLoggers.ProviderEventLoggers — single observability service that owns the shared
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
 *     `Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, { native, canonical })` instead of
 *     juggling per-Layer option threading.
 *
 * Both fields are optional because observability must not prevent startup.
 *
 * @module provider/ProviderEventLoggersLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as EventNdjsonLogger from "./EventNdjsonLogger.ts";

/**
 * Builds both stream views over one shared store. Setup failures are logged
 * and downgraded to the no-op service so diagnostics never block startup.
 *
 * @public Service construction is part of the canonical Effect module API.
 */
export const make = Effect.gen(function* () {
  const { providerEventLogPath } = yield* ServerConfig.ServerConfig;
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
    return ProviderEventLoggers.ProviderEventLoggers.of(
      ProviderEventLoggers.NoOpProviderEventLoggers,
    );
  }

  yield* Effect.addFinalizer(() => store.close());
  return ProviderEventLoggers.ProviderEventLoggers.of({
    native: store.logger("native"),
    canonical: store.logger("canonical"),
  });
});

export const layer = Layer.effect(ProviderEventLoggers.ProviderEventLoggers, make);
