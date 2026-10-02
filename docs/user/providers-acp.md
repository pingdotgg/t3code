# ACP Registry

T3 Code can run coding agents from the official
[ACP Registry](https://agentclientprotocol.com/get-started/registry). Registry agents bring their
own models, tools, and sign-in, while T3 Code provides projects, threads, checkpoints, and task
delegation.

Google Antigravity is available through its official `antigravity-acp` Registry entry. Add it like
any other Registry agent; it does not need an Antigravity-specific T3 Code provider.

T3 Code prefers the current ACP v2 preview protocol and uses its richer messages, usage, plans,
configuration, compaction, and agent-terminal updates when the agent supports them. It also
negotiates ACP v1 for Registry agents that have not migrated yet, so agents such as Pi continue to
work through the same generic integration.

## Add an agent

1. Open **Settings → Providers**.
2. Select **Add provider** and search the ACP Registry.
3. Search for the agent and select **Add** on its result.
4. Confirm the name and instance ID, then complete the agent's sign-in step.

Search only shows agents that can run on the connected server. Registry agents are third-party
code; review an agent's source and license before adding it.

## Where agents run

Registry agents always run on the machine that hosts your T3 Code server. That stays true when you
connect through `app.t3.codes`, T3 Connect, or a relay.

Agents install under `tools/<agent-id>/<version>/` inside T3 home. T3 Code verifies SHA-256 when the Registry entry
provides one; entries without a checksum retain the Registry's HTTPS distribution guarantee.
Registry `npx` and `uvx` packages use T3-owned npm prefixes and Python tool directories at the exact
version published by the Registry. Their commands are available in a new server terminal for
sign-in and direct use. Removing an agent's last provider instance removes T3-managed binary files
but keeps package installs. To use an existing local binary, set **Executable override** explicitly.

## Signing in

Open the agent's account section in **Settings → Providers** on web or desktop. Choose
**Sign in** and, if the agent offers several methods, select one. For an installed, configured
provider, mobile also offers **Settings → Provider accounts**.

Browser sign-in shows the agent's URL and waits for you to open or copy it before telling the
agent to proceed. The page opens on your device, while the agent runs on the environment.
Terminal methods run in an in-app terminal on that environment. On mobile, send responses
through the terminal response field. T3 Code reconnects after terminal login and waits for the
agent to confirm sign-in before reporting success. You can cancel or retry an expired attempt.

Browser and terminal sign-in leave credentials in the agent's own store. Agents that use API keys
through environment variables still take those keys in the instance's environment settings.
A configured environment or agent home applies to both sign-in and chat.

If the agent advertises logout, choose **Sign out**. Changing a shared agent login stops running
threads for instances of that same agent on the environment. Thread history and workspace files
are kept. ACP does not describe account isolation, so adding another instance does not guarantee
a separate account; use the agent's own configuration to isolate accounts when supported.

If an agent cannot complete its advertised flow remotely, its CLI remains available on the
server. For example, Codex supports `codex login --device-auth`, and Grok Build supports
`grok login --device-auth`.

## Models and options

The model picker lists the models the agent reports. If the agent reports none, or hides some, add
your own model IDs under **Custom models** in the instance settings.

Other settings the agent offers, such as reasoning effort or approval mode, appear in the
composer's model options menu like they do for built-in providers. Agents with their own plan and
build modes follow T3 Code's Plan and Build toggle. Models and options that change while an agent
is running update the picker without waiting for another provider probe.

## Commands and skills

Slash commands the agent provides appear under **Provider** in the `/` menu while a session is
running. Commands the agent names with a `$` prefix appear in T3 Code's `$` skill menu instead.

## Native sessions

When an agent advertises ACP session listing and import support, expand its provider card,
choose a project, and select **List sessions**. Importing one creates a deterministic T3 thread
backed by that native session. Importing the same agent session again returns the existing thread,
including when another client performs the import.

The thread keeps the native session's title and last-update value as provider metadata without
overwriting a title you set in T3 Code. Agents that report ACP context usage drive the composer's
context meter and cumulative cost metadata. Text resources and links render as assistant output;
binary resources, images, and audio that T3 Code cannot render yet appear as explicit placeholders
instead of disappearing.

## Permissions and terminals

Registry agents read files, edit, and run commands themselves, under their own sandbox and
approval rules. They start in their own default mode, and their mode picker in the model options
menu switches it. How far an agent is confined depends on that mode and the agent's own settings,
so use its sandbox and permission controls when that matters.

When a registry agent asks for approval, T3 Code answers by the thread's
[permission mode](./permission-modes.md): **Supervised** shows the request in the conversation,
**Auto-accept edits** approves edits and shows the rest, and **Auto** and **Full access** approve
automatically. File reads and searches never wait for approval.

Devin runs its commands through T3 Code's terminals, and those commands follow the thread's
permission mode. For other agents, T3 Code shows the command, output, and exit status the agent
reports but does not run or stop their terminals.

Registry agents can schedule work and use T3's MCP tools. Child-task presentation depends on what
the agent exposes: ACP has no portable native subagent-lineage contract, so richer delegation views
remain agent-specific.

## Checkpoints

Checkpoint rollback restores your files as usual. ACP agents cannot rewind their own conversation,
so the next turn after a rollback starts a fresh agent session that no longer remembers the
conversation from before the checkpoint.

Registry instances are not used for T3's app-owned text generation, such as thread titles, commit
messages, branch names, or pull request descriptions. Configure a text-generation-capable provider
for those actions.

## Advanced configuration

- **Executable override** runs an existing local executable instead of the managed distribution,
  keeping the registry-declared arguments and environment.
- **Authentication method** picks a specific method when the agent advertises more than one.
- **Custom models** adds model IDs the agent does not report.
