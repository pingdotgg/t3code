# Product usage data

The T3 Code server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

T3 Code also sends relay connection traces to Axiom to diagnose T3 Connect connectivity.

To disable product usage events and relay tracing, set `T3CODE_TELEMETRY_ENABLED=false` in
the server or desktop app's environment before starting it. The opt-out also applies to the
desktop renderer and the local web app served by that server, before either starts relay tracing.
This includes custom HTML served by the local server.
Restart the app or server and reload any already-open local web pages after changing the environment.

Relay tracing also honors `T3CODE_OTEL_SDK_DISABLED=true` and `OTEL_SDK_DISABLED=true`.
An explicit `T3CODE_OTEL_SDK_DISABLED` value takes precedence over `OTEL_SDK_DISABLED`,
but does not override `T3CODE_TELEMETRY_ENABLED=false`.

These settings do not configure separately hosted web or mobile clients, or telemetry in
the underlying provider CLIs.
