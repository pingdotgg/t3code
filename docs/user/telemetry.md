# Product usage data

The T3 Code server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To disable collection, set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment before
starting it. This stops product events from being recorded or sent.

## Export diagnostics to your own receiver

To collect traces, metrics, or logs in an OpenTelemetry-compatible service, open
**Settings > General > Diagnostics** on web or desktop and select the environment
you want to monitor. Under **OpenTelemetry export**, enter each signal's full
OTLP HTTP endpoint, save, and restart that environment's server. For example,
a local receiver commonly uses `http://localhost:4318/v1/traces`, `/v1/metrics`,
and `/v1/logs` as its three endpoints.

The receiver must be reachable from the server's machine. For a remote server,
`localhost` means that remote machine. These settings apply to the environment,
including when you use it from mobile.

Each endpoint is resolved at startup: its `T3CODE_OTLP_*_URL` environment variable
wins over desktop startup configuration, which wins over the saved setting.
To disable a signal, clear its saved endpoint and any startup overrides, then
restart. Confirm delivery in your receiver by checking for recent records.

Diagnostic exports go to the receiver you configure and are controlled separately
from product usage collection. Update older servers if log export is unavailable.

### View traces in LangSmith

LangSmith accepts T3 Code traces without installing LangChain. Use a separate
receiver for metrics and logs. Traces show instrumented T3 operations, not every
model call or tool invocation inside a provider; token usage may be absent.

1. Create a LangSmith API key and choose a project, such as `t3-otel`.
2. For a new server, run this PowerShell example on its machine. It prompts for
   the key without putting it in command history:

   ```powershell
   $secureKey = Read-Host 'LangSmith API key' -AsSecureString
   $apiKey = [System.Net.NetworkCredential]::new('', $secureKey).Password
   $env:T3CODE_OTLP_TRACES_URL = 'https://api.smith.langchain.com/otel/v1/traces'
   $env:T3CODE_OTLP_PROTOCOL = 'http/protobuf'
   $env:T3CODE_OTLP_SERVICE_NAME = 't3-otel'
   $env:T3CODE_OTLP_HEADERS = 'x-api-key=' + [uri]::EscapeDataString($apiKey) + ',Langsmith-Project=t3-otel'
   $apiKey = $null
   try { npx.cmd t3 } finally { Remove-Item Env:T3CODE_OTLP_HEADERS }
   ```

   Use your region's API host and the full `/otel/v1/traces` path. See
   [LangSmith's OpenTelemetry setup](https://docs.langchain.com/langsmith/trace-with-opentelemetry)
   for regional endpoints and authentication details.

   Alternatively, save the URL in Diagnostics and omit `T3CODE_OTLP_TRACES_URL`.
   Headers and protocol still require environment variables. For an existing
   server, configure its launcher and restart it; do not start another against
   the same data directory. Desktop must inherit these variables from its launcher.

3. Use T3 Code, then select a recent time range in your LangSmith project.
   Completed spans export in batches, normally every 10 seconds. Open a trace
   to inspect durations, child spans, and errors; startup or HTTP traces confirm delivery.

`T3CODE_OTLP_HEADERS` and `T3CODE_OTLP_PROTOCOL` apply to all three exporters. If
your destinations require different credentials, use an OpenTelemetry Collector
with authentication configured separately for each destination.

If traces are missing, check the project, region, key, time range, running endpoint,
and server output for export failures. To stop exporting, clear endpoints and
overrides as described above, then restart.
