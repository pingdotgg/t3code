# Product usage data

The T3 Code server sends product usage events to T3 Code's own endpoint at `ingest.t3.codes`,
associated with a hashed account or installation identifier. To count how many installations one person
uses, the server also sends hashed account identifiers: your T3 Connect account, your OpenAI and
Claude accounts when you are signed in, and a random identifier for each device that connects. The endpoint keeps a copy of each
event and forwards events to PostHog. Events include the provider, model, reasoning effort,
permission mode, turn and request results, duration, release channel, and token counts when
available. Child-agent token counts are reported separately from the main agent's. Model names
are sent only when they appear in a provider's public model list.

Product events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. The one exception is [agent feedback](#agent-feedback),
which is off unless you turn it on.

## Agent feedback

Agent feedback lets agents tell the T3 team about T3 Code: a T3 tool or `t3` command that did not
do what they expected, a confusing instruction, or a missing capability. Choose a mode in
**Agent feedback** in **Settings > Labs**:

- **Off**, the default: agents do not see the feedback tools, and `t3 feedback` stops with a
  message pointing to Labs.
- **When I ask**: agents send a report only when you ask them to, about anything in T3 Code.
- **Automatic**: agents also report T3 Code problems they hit on their own, such as a T3 tool that
  failed and made them find another way. These reports carry no outline and no message text, and
  go out without asking you. `t3 feedback --kind bug --subject "t3 thread send" --expected "…" --actual "…"`
  sends one the same way, so it works only in this mode.

When you ask your agent for a report, in either mode, T3 Code shows it in the thread as a card
with exactly what would leave your machine, and sends it only if you press **Send**. **Don't
send**, stopping the agent, or leaving the card unanswered for 10 minutes sends nothing, and the
agent is told not to send it another way. Only someone who can run agents on that machine can
answer the card; people on a guest link cannot.

Each report has the kind of problem, the T3 tool or command it concerns (or `general`), and up to
300 characters each of expected behavior, actual behavior, and workaround, written by the agent,
which is told not to quote your messages or code. A report you approved also carries an outline of
the thread's last 5 turns: who spoke, how long each message was, and which tools ran, whether
they worked, and how long they took. The outline has no text. Tools from your other MCP servers
appear only as `mcp`. If you ask the agent to include the conversation, or its last few turns, the
text of your messages and the agent's replies in those turns is attached too, up to 1,000
characters per message and 16 KB in all, oldest text dropped first. Tool inputs and outputs,
files, and attachments are never sent.

Before anything is saved, T3 Code removes file paths (when text mentions one, the rest of that line
goes with it), your user name, machine name, project title, branch, and git remote, and anything
that looks like a key, token, email address, or URL with a password. It cannot recognise your code
or a name written in a sentence, so only ask for the conversation when it holds nothing you would
not send. Reports from agents also name the provider, and the model when it is from the provider's
public model list. No thread IDs or project IDs are sent.

Reports are saved on your machine first, and a declined one is not saved at all. When product usage
data is turned off, saved reports stay there and are not sent. `t3 feedback list` shows recent
reports, the thread each came from, and a line for each outline; `t3 feedback list --json` shows
exactly what each one holds.

## Relay connection diagnostics

T3 Code sends relay connection traces to Axiom to diagnose T3 Connect connectivity. These are
separate from product events. Depending on the client version, traces can include connection
timings, environment identifiers and the connected machine's name. Failed spans can include error
messages and stack traces; error text can quote a value the app was handling.

To disable product events and relay tracing from the server, set
`T3CODE_TELEMETRY_ENABLED=false` in its environment before starting it. Relay tracing also stops
when `T3CODE_OTEL_SDK_DISABLED` or `OTEL_SDK_DISABLED` turns OpenTelemetry export off.

An administrator can turn product events and relay tracing off in the server and desktop app with
a [managed policy](./managed-policy.md#other-capabilities). This does not control traces sent by
separate browser or mobile clients.

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

The web app in a browser, including one the `t3` CLI opens, does not read these environment
variables. When its build has relay tracing configured, it sends its own connection traces even
if the server has opted out. The browser app has no relay tracing toggle.

## Mobile app diagnostics

When the iOS or Android app crashes or hits an error, it sends a report to T3 Code: the error
message, the stack trace, the app version, and the device model and OS version. Each launch also
sends startup timings, and every report carries a random ID for the install. Reports go through
the T3 Connect relay to Axiom. They do not include your threads, prompts, or connection details,
but an error message can quote a value the app was handling.

To stop sending them, turn off **Send crash reports** in **Settings > About T3 Code > Diagnostics**.

The mobile app also sends relay connection traces when its build has tracing configured. These
carry an identifier for the current app session. **Send crash reports** does not control these
traces, and the mobile app has no separate relay tracing toggle. Server environment variables and
managed policy do not disable mobile tracing.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the T3 Connect relay for
[mobile notifications and live activities](./mobile-notifications.md). This is separate from
product events and relay diagnostics. The telemetry opt-out does not disable it.

To stop publishing, turn off **Publish agent activity** under **Settings > Sharing & access** on
the host. Turning off notifications on a phone controls that phone's alerts, not the host's
publishing setting.

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
