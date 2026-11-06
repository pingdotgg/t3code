# Product usage data

OminaX sends no product usage events and no relay connection traces by default, and never sends
usage events to T3 Code. To send them to your own PostHog server, set all three in the server's
environment:

- `T3CODE_TELEMETRY_ENABLED=true`
- `T3CODE_POSTHOG_KEY` to your PostHog project key
- `T3CODE_POSTHOG_HOST` to your PostHog URL, for example `https://posthog.example.ts.net`

Without a key and host, nothing is sent. The rest of this page describes what the events contain.

Product usage events are associated with a hashed account or installation identifier. To count how many installations one person
uses, the server also sends hashed account identifiers: your T3 Connect account, your OpenAI and
Claude accounts when you are signed in, and a random identifier for each device that connects. Events include the provider, model, reasoning effort,
permission mode, turn and request results, duration, release channel, and token counts when
available. Child-agent token counts are reported separately from the main agent's. Model names
are sent only when they appear in a provider's public model list. Lesson features are counted
too: new lessons, side chats opened and finished, the knowledge map, quiz cards, and courses.

Events do not include prompts, responses, lesson text, quiz answers, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output.

T3 Code also sends relay connection traces to Axiom to diagnose T3 Connect connectivity.

To disable product events and relay tracing, set `T3CODE_TELEMETRY_ENABLED=false` in the server's
environment before starting it. Relay tracing also stops when `T3CODE_OTEL_SDK_DISABLED` or
`OTEL_SDK_DISABLED` turns OpenTelemetry export off. The web app in a browser, including one the
`t3` CLI opens, does not read these variables.

An administrator can turn product events and relay tracing off for every user on a machine with
a [managed policy](./managed-policy.md#other-capabilities).

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.
On macOS and Linux it does not read the key and host from your shell profile, so a desktop app
opened from the Dock or launcher sends nothing; start it from a terminal that has all three set.

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
