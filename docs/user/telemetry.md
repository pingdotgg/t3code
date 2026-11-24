# Telemetry

This fork disables product usage reporting, T3 Connect trace exports, mobile crash uploads,
and external OpenTelemetry export. Startup does not read provider files for analytics identity
or create an analytics installation identifier.

Server and desktop logs, local traces, and mobile startup crash logs are available for
troubleshooting. Agent feedback reports can be kept locally and inspected with `t3 feedback list`.
