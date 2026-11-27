# Claude

T3 Code drives your Claude Code installation, login, skills, and plugins. See [provider setup](./install.md#providers) for initial installation.

## Connect Claude Code

For multiple accounts, enable inference hosting in **Settings > Providers** and use **Add account**. CLIProxyAPI keeps the accounts and chooses a credential for each request; Claude remains one provider. See [Host and share inference accounts](#host-and-share-inference-accounts).

To reuse an installed CLI account, choose **Use existing Claude Code**. Leave
**CLAUDE_CONFIG_DIR path** empty to use the CLI's default configuration. For a
custom directory, sign in with `CLAUDE_CONFIG_DIR=/path/to/config claude auth login`
and enter that directory in the provider settings. Keep `HOME` unchanged so Claude
can find the system keychain.

For API keys, custom endpoints, and routers, choose **Use existing Claude Code**
and configure its **Environment variables**.

File paths in the `--settings` and `--append-system-prompt-file` launch arguments
can start with `~` for the home directory of the machine running T3 Code. Any
other relative path is read from the thread's project folder, or its worktree.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

## Host and share inference accounts

In **Settings > Providers**, select the environment that will hold your accounts.
Open **Inference accounts** (under **Advanced** on web and desktop) and turn on hosting. T3 Code
downloads CLIProxyAPI on that machine and verifies the release before starting it.
Add each account, sign in with its provider, paste the final localhost URL back
into Settings, and check its status. The host keeps the provider login and handles
account selection and refresh. Desktop includes compatible CLIProxyAPI releases in **Update everything**.
You can also check for updates in **Inference accounts** on any client. Updating restarts the host, so finish active turns first.

Hosting also picks up a matching Codex or Claude login made in that machine's normal CLI and keeps refreshed tokens in sync with the proxy. On macOS, Claude may ask you to allow T3 Code to access its Keychain credential. Signing out of a CLI does not remove an account already added to the inference host; remove it in **Inference accounts**.

To let another machine use those accounts, turn on **Share inference with paired environments**.
T3 reuses the selected host's existing connection, including SSH, LAN, Tailscale, or T3 Connect.
You do not need an agent link or a separate proxy installation on the consuming machine.
Connect your client to both T3 environments with provider management access.
Select the environment where you want to run agents in **Settings > Providers**.
Turn on **Inference routing** for the provider. T3 tries its previous host first, then
accounts on the current environment, then paired hosts with sharing enabled.
The provider settings show which host it connects to. You can also choose
**Use inference accounts** when adding a Codex or Claude account on web or desktop.
If no host is ready, choose **Set up accounts here** to start hosting and add an account
from the same screen. This connects only to the environment you set up. For an older
environment that doesn't offer inline hosting, open **Inference accounts** to start hosting.

To pick a host yourself, open **Inference accounts** and choose Codex, Claude,
[OpenCode](./providers-opencode.md#shared-inference-accounts), or
[Pi](./providers-pi.md#shared-inference-accounts) beside the host name.
The environment running agents needs the corresponding CLI and must be able to reach the host
through the selected connection. You can also choose the current host for local use.

Use LAN HTTP only on a trusted network. Prompts, responses, and revocable route keys travel unencrypted on that connection.

Select a Codex or Claude model in the thread’s model picker on web, desktop, or mobile.
Remote routes appear as **Codex via [host]** or **Claude via [host]**.
The host receives the model request, including its prompt and tool results.
The agent runs tools and stores files and thread history on its executing environment.
Choosing another host in Settings changes the same provider. Local inference is labeled **Claude** or **Codex**.
Open the model picker or refresh provider status in Settings to update the model list.
The picker hides a model when every route serving it is unavailable. If a provider has no usable models, the picker hides the provider too.
A thread keeps its selected model and shows when it is unavailable. You can choose another model or wait for it to recover.
While a client is connected to the executing environment and other shared inference hosts,
T3 discovers hosts that serve the same provider and saves them as fallback routes. If the
selected host is unreachable, rejects authentication, or reaches a temporary limit, a new
request can use another healthy host that serves the requested model. The agent and its
workspace stay on the executing environment. Keep at least one client connected to each
host when adding new fallback routes; saved routes remain available afterward.
T3 keeps a thread on the host that successfully handles its request after a switch. Each
host selects accounts independently, so a switch between hosts with multiple eligible
accounts may use a different account even when the same login is present on both.

In **Inference accounts**, a rate-limited Claude account shows its retry time when known.
If two hosts share that login, its subscription limit applies on both. Another host can
serve the request if it has an eligible account for the model.

Configure account pooling on the host. Turn on round-robin routing to distribute
requests across eligible accounts, or leave it off to use the first available account.
Session affinity keeps a conversation on its credential while available. The model
picker always shows normal Claude and Codex models. Traex remains a separate backend.

Routing is optional. Turn off **Inference routing** to return to this provider's normal
T3 Code configuration. Standalone CLI configuration is unchanged.
After an upgrade, threads, scheduled tasks, and saved model choices that named an older
route or account pool use the normal Claude or Codex provider. They run through the proxy
only when **Inference routing** is on for that provider.

Remove a provider login on its host, revoke one consuming environment, or turn
off sharing to revoke all remote grants. Remove the route in **Inference accounts** on the executing machine. Stopping hosting keeps the host's accounts
for the next start.

## Compact long conversations

- **Auto-compact threshold**: Set **Auto-compact after** (`100000`–`1000000` tokens) in the Claude instance settings to trigger summarization earlier without changing the model's context window.
- **Manual compaction**: Send `/compact` in chat.
- **Idle compaction (>200k tokens)**: Configure **Settings → Providers → Advanced → Compact idle threads** (overridable per instance):
  - **When you return** (default): Shows a **Compact** chip next to Send once Claude's prompt cache expires (~1 hour on subscriptions, 5 min on API/Bedrock/Vertex). Click it to switch to **Keep** if you want full history.
  - **Before the cache expires (beta)**: Automatically sends `/compact` shortly before the cache expires while history is still cached (falls back to **When you return** if missed).
  - **Never**: Disables idle compaction prompts.

## Steering, usage limits, and tasks

- **Steering**: Steered messages wait until Claude finishes its active tool calls, then enter the same turn (or queue for the next turn if Claude exits or drops them).
- **Usage limits**: Mid-turn limit hits display the window and reset time; Claude holds the turn until reset, or you can stop and resume later.
- **Task lists**: Add `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the instance's **Environment → Variables** to show Claude's task list progress in web and desktop threads.
- **Auto mode**: Uses Claude Code's native auto mode (disabled if `disableAutoMode` is set in Claude's managed, user, or project settings). See [Permission modes](./permission-modes.md).

## Skills and MCP sign-in

- **Skills**: Loaded from `<CLAUDE_CONFIG_DIR>/skills`, the project's `.claude/skills` (config dir wins on name collisions), and enabled Claude plugins (e.g. `plugin:review`). Invoke via `$`. Send `disable-model-invocation` skills one per message.
- **MCP OAuth**: When a Claude MCP server needs sign-in, click **Sign in** on the thread notice, approve in your browser, and paste the final redirect URL into T3 Code (**Finish sign-in**). Connectors added on `claude.ai` authenticate there instead.

## Claude in Chrome

To use the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome) in T3 Code threads, add `--chrome` to **Launch arguments** in the Claude instance settings (applies to new sessions). Requires a direct Anthropic `/login` plan—not supported with API keys, `setup-token`, Bedrock/Vertex, or WSL.

## OpenRouter and local routers

Create a separate Claude instance with its own config directory (e.g. `~/.claude_openrouter`, after running `/logout` if it had a cached Anthropic login) and set **Environment variables**:

Choose **Use existing Claude Code**. Set a separate config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

Add unlisted OpenRouter models via **Add custom model** in the instance settings. See the [OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) or [Claude Code Router](https://github.com/musistudio/claude-code-router) for local router setup.
