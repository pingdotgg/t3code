# ACP Registry

T3 Code can run coding agents from the official
[ACP Registry](https://agentclientprotocol.com/get-started/registry). Registry agents bring their
own models, tools, and sign-in, while T3 Code provides projects, threads, checkpoints, and task
delegation.

## Add an agent

1. Open **Settings → Providers**.
2. Select **Add provider instance**, then **ACP Registry**.
3. Search for the agent and select **Add** on its result.
4. Confirm the name and instance ID, then select **Add instance**.

Search only shows agents that can run on the connected server. Registry agents are third-party
code; review an agent's source and license before adding it.

## Where agents run

Registry agents always run on the machine that hosts your T3 Code server. That stays true when you
connect through `app.t3.codes`, T3 Connect, or a relay.

Binary agents download into a managed cache and are checked against the registry's checksum.
`npx` and `uvx` agents install through their package runner when their first session starts.
Removing an agent's last provider instance also removes its managed files.

## Signing in

T3 Code never collects or stores credentials for registry agents. You sign in with the agent's own
method, on the server machine, under the account that runs T3 Code.

The provider card shows what the agent needs: some agents sign in through the browser on their own,
some show a terminal command to run, and some take API keys through the instance's environment
settings. After you sign in, T3 Code picks it up on the next automatic provider check.

For Codex, credentials belong to the Codex CLI on the server. Run `codex login status` to check
them, or `codex login --device-auth` to sign in with a ChatGPT subscription.

For Grok Build on a remote or headless server, run `grok login --device-auth`, or
`npx -y @xai-official/grok login --device-auth` if Grok is not installed globally. See the
[Grok Build authentication guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md).

## Models and options

The model picker lists the models the agent reports. If the agent reports none, or hides some, add
your own model IDs under **Custom models** in the instance settings.

Other settings the agent offers, such as reasoning effort or approval mode, appear in the
composer's model options menu like they do for built-in providers. Agents with their own plan and
build modes follow T3 Code's Plan and Build toggle.

## Commands and skills

Slash commands the agent provides appear under **Provider** in the `/` menu while a session is
running. Commands the agent names with a `$` prefix appear in T3 Code's `$` skill menu instead.

## Permissions and terminals

Registry agents follow the thread's normal runtime and sandbox settings: full-access threads
approve permitted actions automatically, approval-required threads keep asking. Files the agent
edits through T3 Code and commands it runs in embedded terminals stay on the connected server, and
terminal output appears inside the agent's tool calls in the thread.

Registry agents can also delegate child tasks, schedule work, and use the collaborative browser,
just like built-in providers.

## Checkpoints

Checkpoint rollback restores your files as usual. ACP agents cannot rewind their own conversation,
so the next turn after a rollback starts a fresh agent session that no longer remembers the
conversation from before the checkpoint.

## Advanced configuration

- **Executable override** runs an existing local executable instead of the managed distribution,
  keeping the registry-declared arguments and environment.
- **Authentication method** picks a specific method when the agent advertises more than one.
- **Custom models** adds model IDs the agent does not report.
