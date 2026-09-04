# OpenCode

T3 Code uses the OpenCode setup on the connected environment. With a remote environment, its
OpenCode login and configuration apply, not the setup on your desktop or phone.

T3 Code requires OpenCode 1.14.19 or newer. It checks the server version before it loads models or
starts work. If the check fails, update OpenCode or fix the server URL and password, then refresh
the provider status. Reconnecting the client also runs the check again.

## Server authentication

Without a server URL, T3 Code starts a local OpenCode server. The process inherits
`OPENCODE_SERVER_PASSWORD` from the environment. A password in the provider settings overrides
that environment value for both the local process and T3 Code.

With a server URL, T3 Code connects to that external server and uses only the password in the
provider settings. It does not send a local `OPENCODE_SERVER_PASSWORD` to an external server.
OpenCode uses this password for HTTP Basic authentication.

## Approvals

In **Supervised** and **Auto** modes, OpenCode can read normal project files, search files, load
skills, and update its task list without approval. Files such as `.env` and `.env.local` still
require approval. `.env.example` does not. OpenCode does not have an AI approval reviewer, so
**Auto** uses the same permission rules as **Supervised**.

OpenCode asks before it runs commands, edits files, accesses the web, or accesses directories
outside the workspace. **Auto-accept edits** also permits file edits without approval.
**Full access** permits all these actions. Questions that need your answer can still appear.

An **Approval** badge means OpenCode needs a decision. Open the thread to see the action and
choose one of these options:

- **Allow once** permits this request.
- **Allow for workspace** permits matching requests in other OpenCode sessions in the same
  workspace. It is not limited to the current thread.
- **Deny** rejects this request. Use **Stop** to stop the whole turn.

If a connection error prevents the reply, the approval stays available so you can try again.

## Progress

T3 Code shows OpenCode's response text and tool results while work runs. The web and desktop apps
also show its task-list progress. A task-list update does not require approval.

If the OpenCode connection closes unexpectedly, T3 Code shows an error. Send another prompt to
reconnect to the same OpenCode session.

## Stop a turn

When you select **Stop**, T3 Code stops the main OpenCode session and all nested child sessions.
T3 Code waits for this cleanup before it marks the turn as stopped or sends the next prompt. It
does not stop unrelated OpenCode sessions. After Stop succeeds, pending approvals and questions
are cleared.

Stop reports an error if OpenCode cannot stop the main session or list or stop a child session.
When T3 Code closes an OpenCode session, it also tries to stop the child sessions, but this
teardown is best effort.

## Refresh the model list

T3 Code loads the model list when an enabled OpenCode provider starts and keeps the list in its
cache. Reconnecting a client or using a refresh control asks OpenCode for the list again. The
periodic provider health setting does not refresh OpenCode's catalog.

After changing an OpenCode login or configuration outside T3 Code, open **Settings > Providers**,
select the environment, and choose **Refresh provider status**. Changing the provider's
configuration in T3 Code also replaces that provider connection.

On mobile, open the thread settings and select **Refresh models**. The control stays disabled while
the refresh runs and shows an error if the refresh fails.

OpenCode reads credential changes on each model-list request. Native OpenCode configuration files
can stay cached while the local helper is running. The helper closes after 30 seconds with no
model-list or text-generation work. Refresh after that idle period to start a new helper and read
the file changes. Repeated refreshes or active helper work can extend this wait.

T3 Code does not own an external OpenCode server. Native configuration changes on that server can
require its own reload or restart before a refresh returns the new list.

If a refresh fails, T3 Code keeps the last known models, slash commands, and skills. Fix the
connection, then refresh again. A successful refresh can remove entries that OpenCode no longer
offers.

## Continue an existing thread

An existing thread keeps its selected model and options when that model is temporarily absent
from the catalog. The web picker shows an **Unavailable** row and keeps saved option values visible
until the model metadata returns. T3 Code does not switch the thread to the first model in the
list.

The stored selection does not guarantee that OpenCode can still run the model. If the provider
rejects it, select an available model before trying again.
