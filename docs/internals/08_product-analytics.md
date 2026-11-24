# Product analytics

PseudoCode sends no analytics anywhere but the user's own machine. Upstream T3 Code ships three
outside sinks, and the fork disables each at one point so callers and settings stay unchanged:

- Server product events (PostHog through `ingest.t3.codes`): `AnalyticsService.layer` in
  [`apps/server/src/telemetry/AnalyticsService.ts`](../../apps/server/src/telemetry/AnalyticsService.ts)
  is a no-op.
- T3 Connect relay traces (Axiom) from server, web, and mobile: `layer` in
  [`packages/shared/src/relayTracing.ts`](../../packages/shared/src/relayTracing.ts) never builds an
  exporter, whatever credentials a build carries.
- Mobile crash reports and launch timings (expo-observe): the native endpoint in
  `apps/mobile/app.config.ts` is `https://observe.invalid`, and
  [`observe.ts`](../../apps/mobile/src/features/observability/observe.ts) turns dispatching off.

OTLP export to a receiver the user configures (Settings > Maintenance > Diagnostics, or
`T3CODE_OTLP_*` and `OTEL_EXPORTER_OTLP_*`) stays, because the user chooses where it goes.

When syncing upstream, check new code for any other outside sink and disable it the same way.
