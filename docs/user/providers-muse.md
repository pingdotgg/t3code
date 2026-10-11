# Muse Code

Muse Code is a beta integration and is disabled by default. Install
[Muse Code](https://dev.meta.ai/docs/muse-code) on the machine hosting your
environment, then run `muse login` as the account that runs T3 Code.

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable **Muse Code**. Set **Binary path** if Muse is not on the host's `PATH`.
Refresh provider status after installation or login, then select Muse in a
thread's model picker.

Provider status shows when Muse is signed out. Run `muse login` on the host,
then refresh its status.

## Sign-in and API keys

T3 Code ignores a `META_API_KEY` that the T3 server inherits from its own
environment, so Muse uses the credential saved on the host by `muse login`. To
use an API key instead, add `META_API_KEY` to the Muse instance's environment
variables in **Settings → Providers**. Muse gives that key priority over the
saved login.

## Remote access and instances

Connect from web, desktop, or mobile through [remote access](./remote-access.md).
Muse uses the selected environment's files and login; connecting devices do not
need Muse installed. Install and sign in separately on each host where you want
Muse to run.

Add a provider instance for a separate configuration. Instances on the same host
share its Muse login; give an instance its own `META_API_KEY` to bill it
separately. Existing conversations retain their instance when its model catalog
becomes unavailable.

## Models

Models and reasoning choices come from Muse on the selected host. After changing
Muse configuration, refresh provider status in **Settings → Providers**. On
mobile, pull down in thread settings to refresh models. If a saved model becomes
unavailable, select an available model before sending another message.

Muse can list models that your account cannot use. If a message fails with
"does not exist or you lack access", pick another model, or add one your account
can use under **Custom models** in the instance settings.

## Usage limits

**Usage → Limits** shows your Meta subscription's session and weekly windows.
Muse reports them with each reply, so they appear after Muse's first reply
since the T3 server started. The same Meta account signed in on several hosts,
or reported by a CLIProxyAPI hub, counts once.

With an API key, including a hub's key, Muse does not report limits itself.
[Connect the hub](./usage.md#connect-a-cliproxyapi-hub) to see the Meta
accounts it routes to.

When a turn stops because a window ran out, the thread is marked **Limited**,
and [Resume at reset](./thread-sidebar.md#inspect-agent-work) works as it does
for Codex and Claude.

## Permissions and limitations

Muse offers two [permission modes](./permission-modes.md): **Supervised** asks
before commands and edits, and **Full access** runs them without asking. Muse has
no equivalent of **Auto-accept edits** or **Auto**, so they are not offered. Muse
does not offer a separate Plan mode in T3 Code.

Muse can use T3 Code's tools. If Muse cannot reach them, the turn continues
without them. Switching providers can pass conversation context as a handoff.

Muse skills do not appear in the composer's `$` menu. Muse still loads them
itself. Manage them with `muse skills` on the host.

Forking a Muse conversation starts a new session with a copy of the conversation
context. Conversation rewind is unavailable.

Install Muse and sign in on the host; in-app installation and sign-in are not
available. Updates can run from **Settings → Providers** when T3 Code recognizes
the Muse launcher; otherwise update Muse on that host manually.

To stop using Muse in an environment, disable it in **Settings → Providers**.
This keeps the host's Muse login, thread history, and workspace files.
