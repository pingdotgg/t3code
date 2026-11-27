# Product usage data and diagnostics

PseudoCode sends no product usage events, relay traces, or crash reports to PseudoCode, T3, or any
third party, on any surface: desktop, web, the `t3` CLI, and the iOS and Android apps. It does not
read other tools' sign-in files to identify you, and it creates no device or install id for
analytics. The server and desktop app also refuse connections to T3 Code's analytics and tracing
hosts, so no settings or environment variables are needed. Diagnostics leave your machine only
when you point them at a receiver yourself, as below.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the Cloud Connect relay for
[mobile notifications and live activities](./mobile-notifications.md). This is separate from
product usage data.

## Export diagnostics to your own OpenTelemetry receiver

Open **Settings → Maintenance → Diagnostics** (per environment) and enter OTLP HTTP endpoints (e.g. `http://localhost:4318/v1/traces`), save, and restart the server. Use **Test** to verify connectivity.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` env vars override saved settings (use `T3CODE_OTLP_HEADERS` / `T3CODE_OTLP_PROTOCOL=http/protobuf` or the standard `OTEL_EXPORTER_OTLP_*` equivalents for auth and protobuf).
