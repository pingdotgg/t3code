# Product usage data

Product analytics is on by default. Turn it off in onboarding or **Settings > About > Privacy**.
On mobile, use **Settings > Maintenance > Privacy**. The choice is saved on each environment
and applies to everyone connected to it. Turning it off stops collection without restarting and
discards queued events, including failed deliveries. Turning it back on collects new events only.

Startup events can be recorded and sent before the onboarding choice appears. To prevent
collection from the first start, set `T3CODE_TELEMETRY_ENABLED=false` before launching, as
described below. Changing the saved preference requires permission to change environment
settings; ask the environment administrator if the control is unavailable.

When enabled, the T3 Code server sends product usage events to T3 Code's own endpoint at `ingest.t3.codes`,
associated with a hashed account or installation identifier. To count how many installations one person
uses, the server also sends hashed account identifiers: your T3 Connect account, your OpenAI and
Claude accounts when you are signed in, and a random identifier for each device that connects. The endpoint keeps a copy of each
event and forwards events to PostHog. Events include the provider, model, reasoning effort,
permission mode, turn result, duration, release channel, and main-agent token totals when
available.

These identifiers are pseudonymous, not anonymous: events can be linked to the same account
or installation. Account IDs use unsalted SHA-256, so someone who knows an account ID can
calculate its hash and match it to events. The server reads identifiers from Codex and Claude
Code login files (`~/.codex/auth.json` and `~/.claude.json`); login tokens are not sent as analytics.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

The product analytics switch does not control relay diagnostics, mobile crash reports, or
OpenTelemetry exports you configure yourself. T3 Code also sends relay connection traces to
Axiom to diagnose T3 Connect connectivity, including connection setup before signing in.

To disable product events and relay tracing, set `T3CODE_TELEMETRY_ENABLED=false` in the server's
environment before starting it. This overrides the saved product analytics preference.
Relay tracing also stops when `T3CODE_OTEL_SDK_DISABLED` or
`OTEL_SDK_DISABLED` turns OpenTelemetry export off. The web app in a browser, including one the
`t3` CLI opens, does not read these variables.

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

## Mobile app crash reports

When the iOS or Android app crashes or hits an error, it sends a report to T3 Code: the error
message, the stack trace, the app version, and the device model and OS version. Each launch also
sends startup timings, and every report carries a random ID for the install. Reports go through
the T3 Connect relay to Axiom. They do not include your threads, prompts, or connection details,
but an error message can quote a value the app was handling.

To stop sending them, turn off **Send crash reports** in **Settings > About T3 Code > Diagnostics**.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
