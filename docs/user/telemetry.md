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

Clear a field and save to disable that signal after restarting. Server environment
variables and desktop startup configuration take precedence over saved endpoints;
remove those overrides too if they are configured. The running configuration is
shown separately so you can compare it with your saved settings. Confirm delivery
in your receiver by checking for recent records.

Diagnostic exports go to the receiver you configure and are controlled separately
from product usage collection. Update older servers if log export is unavailable.

### View traces in LangSmith

LangSmith can receive T3 Code's existing OpenTelemetry traces; you do not need to
install LangChain. A trace shows the timing and child operations of one activity.
Metrics summarize trends across activities, while structured logs record individual
messages. Use a separate receiver, such as Aspire or Grafana, for OTLP metrics and
logs; the LangSmith endpoint below accepts traces.

1. Create a LangSmith API key in the workspace where you want to inspect traces.
   Choose a project name, such as `t3-otel`.
2. On the machine running the T3 Code server, configure its startup environment.
   This PowerShell example prompts for the key without putting it in command
   history, then starts a server from the same shell:

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

   Use the API host for your LangSmith region. T3 Code takes a **full signal URL**,
   including `/otel/v1/traces`, rather than a base OTLP URL. See
   [LangSmith's OpenTelemetry setup](https://docs.langchain.com/langsmith/trace-with-opentelemetry)
   for regional endpoints and authentication details.

   Alternatively, save that traces URL in **Settings > General > Diagnostics**
   and omit `T3CODE_OTLP_TRACES_URL` from the launch environment. The API key header
   and protocol still need startup environment variables. For an existing server,
   configure its launcher and restart it instead of starting a second server
   against the same data directory. A desktop server must inherit these variables
   from its launcher; setting them in an unrelated terminal has no effect.

3. Use the connected T3 Code client, then open the project in LangSmith and select
   a recent time range. Completed spans are exported in batches, normally every
   10 seconds. Open a trace to inspect durations, child spans, attributes, and
   recorded errors. Startup or HTTP traces are enough to confirm delivery; you
   do not need to produce a failed agent turn.

The traces describe operations instrumented by T3 Code. Exporting them does not
automatically expose every model call or tool invocation inside each provider.
An empty prompt or token-usage view does not mean export failed.

Keep metrics and logs pointed at their own receiver if you use them.
`T3CODE_OTLP_HEADERS` and `T3CODE_OTLP_PROTOCOL` apply to all three exporters. If
your destinations require different credentials, use an OpenTelemetry Collector
with authentication configured separately for each destination.

If no traces appear, check the project, region, key, recent time range, and the
server's running endpoint. Check server output for export failures. Saving an
endpoint alone does not prove delivery. To stop exporting, remove the traces
URL from the launch environment and saved settings, remove any desktop override,
and restart the server.
