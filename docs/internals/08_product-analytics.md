# Product analytics

PseudoCode has no product analytics. Upstream T3 Code ships server usage events to PostHog through
`ingest.t3.codes` (with hashed account ids read from `~/.codex/auth.json` and `~/.claude.json`, a
persistent install id, and hashed device ids that clients put on WebSocket URLs), relay traces to
Axiom from server, web, and mobile, and mobile crash reports through expo-observe. The fork deletes
that code rather than disabling it, so there is nothing for a setting or build variable to turn on.

Two layers keep it out:

- [`scripts/no-upstream-telemetry.test.ts`](../../scripts/no-upstream-telemetry.test.ts) fails CI
  when shipped source names those services, the removed identifiers, or an analytics SDK
  dependency. An upstream sync that brings any of it back fails here; delete the reintroduced code
  instead of allowlisting it.
- At runtime, [`telemetryBlocklist.ts`](../../packages/shared/src/telemetryBlocklist.ts) lists the
  hosts. The server fails DNS for them (`refuseTelemetryHosts` in
  [`outboundHttp.ts`](../../apps/server/src/outboundHttp.ts)), and the desktop main window session
  cancels requests to them. Provider CLIs run as their own processes and are not covered.

OTLP export to a receiver the user configures (Settings > Maintenance > Diagnostics, or
`T3CODE_OTLP_*` and `OTEL_EXPORTER_OTLP_*`) stays, because the user chooses where it goes.
