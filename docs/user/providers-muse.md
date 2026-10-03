# Muse Code

Muse Code is a beta integration and is disabled by default. Install
[Muse Code](https://dev.meta.ai/docs/muse-code) on the machine
hosting your environment, then run `muse login` as the account that runs T3 Code.

Open **Settings > Providers** in the web or desktop app, select the environment,
and enable **Muse Code**. Set **Binary path** if Muse is not on the host's `PATH`.
Refresh provider status after installation or login, then select Muse in a
thread's model picker.

T3 Code uses the host's saved Muse credentials and ignores `META_API_KEY` when
starting Muse. Sign in with your Muse subscription account. A saved API
credential can still select API billing; provider status does not verify your
subscription or billing method.

## Remote access and instances

Connect from web, desktop, or mobile through [remote access](./remote-access.md).
Muse uses the selected environment's files and login; connecting devices do not
need Muse installed. Install and sign in separately on each host where you want
Muse to run.

Instances share the host's saved Muse login unless you isolate it with Muse's
own environment settings. Add a provider instance for a separate configuration.
Its environment variables and executable are configured on the selected server.
Existing conversations
retain their instance when its model catalog becomes unavailable.

## Models

Models and reasoning choices come from Muse on the selected host. After changing
Muse configuration, refresh provider status in Settings. On mobile, use
**Refresh models** in thread settings. If a saved model becomes unavailable,
select an available model before sending another message.

## Permissions and limitations

Muse follows the shared [permission modes](./permission-modes.md). **Auto** asks
for approval where **Supervised** would because Muse has no automatic approval
reviewer. Muse does not offer a separate Plan mode in T3 Code.

T3 Code connects its tools through Muse's session MCP support. Update Muse on
the host if it cannot accept session MCP servers. Switching providers can pass
conversation context as a handoff.

Forking a Muse conversation starts a new session with a copy of the conversation
context. Conversation rewind is unavailable.

Install Muse and sign in on the host; in-app installation and sign-in are not
available. Updates can run from **Settings > Providers** when T3 Code recognizes
the installer; otherwise update Muse on that host manually.

To stop using Muse in an environment, disable it in **Settings > Providers**.
This keeps the host's Muse login, thread history, and workspace files.
