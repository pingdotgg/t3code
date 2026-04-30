/**
 * ProviderEventLoggers — single observability service that owns the two
 * shared NDJSON streams the provider runtime writes:
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
 *     should share one underlying log writer per stream — opening N writers
 *     against the same rotating file would race the rotation logic. Owning
 *     the loggers on a single tag keeps that invariant intact.
 *   - Tests can swap one (or both) loggers with in-memory recorders by
 *     `Layer.succeed(ProviderEventLoggers, { native, canonical })` instead of
 *     juggling per-Layer option threading.
 *
 * Both fields are optional. `makeEventNdjsonLogger` returns `undefined` when
 * the target directory cannot be created; we forward that as `undefined`
 * rather than failing the boot Layer, matching the previous best-effort
 * behavior of `server.ts`.
 *
 * @module provider/Layers/ProviderEventLoggers
 */
import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

export interface ProviderEventLoggersShape {
  readonly native: EventNdjsonLogger | undefined;
  readonly canonical: EventNdjsonLogger | undefined;
}

/**
 * Shared logger pair for native + canonical provider event streams.
 *
 * Service value is intentionally a struct of two optional loggers rather
 * than two parallel tags. Construction site is one place
 * (`ProviderEventLoggersLive`); consumers (drivers, `ProviderService`) read
 * one tag and pluck the field they need.
 */
export class ProviderEventLoggers extends Context.Service<
  ProviderEventLoggers,
  ProviderEventLoggersShape
>()("t3/provider/ProviderEventLoggers") {}

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
 * Live Layer that builds both loggers from `ServerConfig.providerEventLogPath`.
 * If the directory create fails for either stream, the corresponding field
 * is `undefined` and writes from that stream become no-ops downstream.
 */
export const ProviderEventLoggersLive = Layer.effect(
  ProviderEventLoggers,
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig;
    const native = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });
    const canonical = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
    });
    return {
      native,
      canonical,
    } satisfies ProviderEventLoggersShape;
  }),
);
