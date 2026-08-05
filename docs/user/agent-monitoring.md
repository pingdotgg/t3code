# Sentry agent monitoring

Sentry agent monitoring is an optional beta that sends one trace when an agent turn settles. It is
off by default.

## Set it up

1. Create or choose a Sentry project.
2. In Sentry, open **Project Settings → Client Keys (DSN)** and copy the **DSN URL**.
3. In T3 Code, open **Settings → Beta**, enable **Sentry agent monitoring**, paste the DSN, and
   select **Save DSN**.
4. Restart the T3 Code server. A restart is also required after replacing the DSN.

Use the DSN URL, not the OTLP endpoint or its authentication header. Turning monitoring off stops
new exports immediately.

## Check the Sentry URLs

Sentry's **Client Keys (DSN)** page also shows the project's OpenTelemetry endpoints. The values
should have the following relationship:

```text
DSN:         https://<public-key>@<ingest-host>/<project-id>
OTLP traces: https://<ingest-host>/api/<project-id>/integration/otlp/v1/traces
```

The ingest host and project ID must match. T3 Code derives the OTLP traces URL and authentication
header from the DSN, so no separate exporter URL or header is needed.

## Verify traces

Run a small agent turn and let it complete or fail. In Sentry, open **Explore → Traces**, select the
project, and filter for `span.op:gen_ai.invoke_agent`. Open a result and use **Agent Timeline** or
**Attributes** to inspect the provider, model, duration, tokens, cost, completion state, and tool
count. New projects can take a few seconds to show their first trace.

The trace's **Input** and **Output** tabs should contain no prompt or response content.

## Data sent

The trace can include the provider and model, thread and turn identifiers, duration, token usage,
cached and reasoning tokens, cost when the provider reports it, tool-use count, completion state,
and a normalized error class.

T3 Code does not send prompts, responses, reasoning, source code, diffs, terminal output, file
paths, or raw provider events through this integration. The DSN is stored in the server's secret
store and is not returned to clients after it is saved.
