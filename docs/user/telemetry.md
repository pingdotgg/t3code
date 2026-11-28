# Usage data and diagnostics

Hyakki collects no usage data. There are no product analytics, no crash reports and no relay
traces, and nothing about you, your machine or your projects is sent to the people who make it.
See the [privacy notice](../../PRIVACY.md).

The coding agents you run are separate programs with their own providers and terms. Hyakki
starts them; it does not control or answer for what they send.

## Agent feedback

**Settings → Labs → Agent feedback** lets an agent write down a Hyakki bug or missing capability
it ran into. Reports stay on your machine: inspect them with `hyakki feedback list [--json]`. File
paths, usernames, hostnames, git remotes and secret-like strings are scrubbed before a report is
saved.

## Agent activity for mobile notifications

**Settings → Sharing & access → Publish agent activity** sends project/thread titles, model names, and turn status to the Hyakki Connect relay for [mobile notifications and live activities](./mobile-notifications.md). This is independent of telemetry—turn it off directly on the host if you don't want it.

## Export diagnostics to your own OpenTelemetry receiver

Open **Settings → Maintenance → Diagnostics** (per environment) and enter OTLP HTTP endpoints (e.g. `http://localhost:4318/v1/traces`), save, and restart the server. Use **Test** to verify connectivity.

`HYAKKI_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` env vars override saved settings (use `HYAKKI_OTLP_HEADERS` / `HYAKKI_OTLP_PROTOCOL=http/protobuf` or the standard `OTEL_EXPORTER_OTLP_*` equivalents for auth and protobuf).
