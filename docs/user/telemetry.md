# Anonymous usage data

The T3 server sends anonymous product events to PostHog. These events include
the provider, model, reasoning effort, permission mode, turn result, duration,
and normalized main-agent token totals when the provider reports them.

T3 Code does not send prompts, responses, file contents, raw provider events,
thread IDs, turn IDs, provider instance IDs, authentication tokens, or child
agent output. Token totals can be complete, partial, or unavailable. Child
agent token use is not included.

Set `T3CODE_TELEMETRY_ENABLED=false` before you start the T3 server to stop
product events from being recorded or sent. The server still derives an
anonymous identifier during startup and can create its local fallback
identifier file.
