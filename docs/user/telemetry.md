# Usage data and diagnostics

Exploro sends no usage data, analytics, or diagnostics to T3 Code or to Exploro. The upstream
T3 Code product analytics (`ingest.t3.codes`, PostHog) are off by default and have no built-in
endpoint, so an unconfigured server sends nothing.

T3 Connect (sign-in, the relay, mobile notifications, and relay connection traces) only turns on
when a build sets its relay and sign-in configuration. Exploro builds do not, so those features are
unavailable and send nothing.

The server still talks to:

- the model providers you use (for example Anthropic or OpenAI), through their own CLIs;
- Exploro's GitHub repository, for the published model list, unless you turn off
  **Provider update checks**;
- Google's Chrome for Testing downloads, the first time the built-in browser is set up;
- the sites you ask an agent to test.

If you run your own analytics endpoint, set `T3CODE_TELEMETRY_ENABLED=true`,
`T3CODE_POSTHOG_HOST`, and `T3CODE_POSTHOG_KEY` in the server's environment. All three are needed.
An administrator can force analytics off with a [managed policy](./managed-policy.md#other-capabilities).

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
