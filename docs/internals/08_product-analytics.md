# 08 · No product analytics

Hyakki sends nothing to its makers. There is no analytics backend, no crash reporting and no relay
tracing, and none should be added. What users see and rely on is [PRIVACY.md](../../PRIVACY.md).

## What stays, and why

- `apps/server/src/telemetry/AnalyticsService.ts` keeps the service shape upstream code calls, but
  `record` always answers `false` and nothing is queued or sent. Keeping the shape lets fixes from
  upstream T3 Code apply without rewriting every caller.
- `packages/shared/src/relayTracing.ts` `layer` always provides no relay tracer, whatever it is
  configured with, so no client exports relay spans.
- The mobile app compiles `expo-observe` in, so `apps/mobile/src/features/observability/observe.ts`
  turns dispatching off on every start, and the Observe endpoint is a name that never resolves.
- Agent feedback (`apps/server/src/feedback`) stores reports locally only. A report is marked
  unsent because the analytics service refuses it.

## What is not telemetry

- OTLP export to an endpoint the user configures (Settings › Maintenance › Diagnostics, or the
  `HYAKKI_OTLP_*` / `OTEL_EXPORTER_OTLP_*` variables). It goes only where the user points it.
- Desktop host state (power, idle, lock) passed from the desktop shell to its own local backend.
- The coding agents Hyakki starts. They talk to their own providers under their own terms.

## Upstream fixes

When a cherry-picked upstream fix touches analytics, relay tracing or Observe, keep the no-op
behaviour above: take the fix, drop any new event, exporter or endpoint.
