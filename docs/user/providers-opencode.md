# OpenCode

Run OpenCode **1.14.19+** or **OpenCode 2.0.18+** in T3 Code. Install and authenticate OpenCode on the server machine, then enable it in **Settings → Providers** (see [provider setup](./install.md#providers)).

## OpenCode 1.x vs. 2.x

T3 Code detects your installed version automatically. OpenCode 1.x has **Limited support**.

- OpenCode 2 ships as a separate package (`@opencode/cli`, e.g. `npm install -g @opencode/cli`). T3 Code's update button upgrades your installed package without switching 1.x to 2.x.
- Do not run 1.x and 2.x side by side on the same machine—OpenCode 2 converts the shared database on first run. Existing 1.x threads continue on 2.x.

OpenCode 2's native subagents inherit the parent thread's allowed T3 tools, but not
T3's per-session tool guidance. T3 directs agents to use `delegate_task` for child
work that needs project memory, conversation summaries, or code graph. Those
delegated threads receive T3's tools and instructions before they start work.

## Local or external server

- **Managed local server** (default): Leave **Server URL** empty. Uses your configured password, `OPENCODE_SERVER_PASSWORD`, or a generated password.
- **External server**: Set **Server URL** and password in provider settings (does not forward local `OPENCODE_SERVER_PASSWORD`).
- **Updating a local service**: When **Server URL** points to a local OpenCode background service (using its exact host/port—`127.0.0.1` for `0.0.0.0`, `[::1]` for `[::]`, not `localhost`), T3 Code upgrades the CLI and restarts the service (interrupting active turns; configure service env vars with `opencode service set env <name> <value>`). Other external servers must be restarted manually.

## Compaction, approvals, and catalog refresh

Configured servers, including localhost URLs, do not receive T3 Code's agent tools.
Project memory, conversation summaries, code graph, delegation, and other T3 tools
are unavailable to the agent in this mode. Leave **Server URL** empty to use these
integrations. This applies to both OpenCode 1.x and 2.x.

When **Server URL** points to a locally running server (such as `127.0.0.1`),
the update button upgrades its installed CLI. If that server is this machine's
OpenCode background service, T3 Code then restarts it on the new version. The URL
must use the service's own protocol, host, and port. For a service listening on
`0.0.0.0` use `127.0.0.1`, and for `[::]` use `[::1]`.

Restarting interrupts running turns, and the service then runs with T3 Code's
environment. Set any variables it needs with `opencode service set env <name> <value>`.

T3 Code does not restart any other server, including the background service
reached through `localhost`. That server can still report the previous version
until you restart it. For a loopback URL, T3 Code shows that restart requirement
instead of treating the CLI update as a failure.

T3 Code waits for a local server it started to recover after a lost connection.
You can stop the turn while it reconnects. If the server exits or an external
connection cannot be restored, send another prompt to resume the same OpenCode
session.

OpenCode handles retries while a turn is running. If its retries run out on a rate limit
and the provider reports when to try again, choose **Resume at reset** on the failed
thread. T3 will continue that thread at or after the reported time. A service overload
can also return HTTP 429. OpenCode handles those retries itself.

## Shared inference accounts

OpenCode can use the accounts on an [inference host](./providers-claude.md), next to
its own logins. In **Settings > Inference accounts**, choose **OpenCode** beside the
host, or turn on **Inference routing** in OpenCode's provider settings. The host's models
then appear in the model picker under **T3 inference**.

OpenCode and [Pi](./providers-pi.md#shared-inference-accounts) can run every model the host has
an account for. On the host, **Add an account** also offers
Antigravity, xAI, Kimi, Meta AI, and Devin sign-ins. Claude and Codex each use only
their own accounts.

T3 Code must start the OpenCode server itself, so this is unavailable with a **Server URL**.
Choose the route again in Settings to refresh the model list after changing accounts.

## Approvals

OpenCode follows the shared [permission modes](./permission-modes.md). **Auto** has
the same rules as **Supervised** because OpenCode has no AI approval reviewer.
Environment files such as `.env` and `.env.local` need approval in restricted
modes even though normal file reads do not; `.env.example` is allowed.

**Allow for workspace** applies to matching requests in other OpenCode sessions
using the same workspace. It is broader than the current thread, especially on a
shared external server. Use **Allow once** for a single request. Denying an action
does not stop the whole turn.

## Refresh models, commands, and skills

After changing an OpenCode login or configuration, use **Refresh provider status**
in **Settings > Providers** for that environment. On mobile, use **Refresh models**
in the thread settings. Reconnecting also refreshes the catalog; periodic provider
health checks do not.

Credential changes are read on refresh. Native OpenCode configuration can remain
cached while the local helper is running. Let it sit for 30 seconds without model
refreshes or text-generation work, then refresh again to reload the files. Repeated
refreshes keep the helper alive. An external server may need its own reload or
restart before T3 Code can see configuration changes.

Models defined in a project's own `opencode.json` appear only in that project's
model picker, after T3 Code reads the project's catalog the first time the picker
opens there.

Existing threads keep their selected model and options even when it disappears
from the catalog. If OpenCode rejects that model, select an available one and retry.
