# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

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
Select the environment where you want to run agents in Settings. Under **Route
requests through an environment**, choose Codex, Claude, [OpenCode](./providers-opencode.md#shared-inference-accounts),
or [Pi](./providers-pi.md#shared-inference-accounts) beside the host name.
The environment running agents needs the corresponding CLI and must be able to reach the host
through the selected connection. You can also choose the current host for local use.

Use LAN HTTP only on a trusted network. Prompts, responses, and revocable route keys travel unencrypted on that connection.

Select **Codex via …** or **Claude via …** in a thread on web, desktop, or mobile.
The host receives the model request, including its prompt and tool results.
The agent runs tools and stores files and thread history on its executing environment.
Choosing another host in Settings changes the same provider. Local inference is labeled **Claude** or **Codex**.
Choose the route again in Settings to refresh its model list after changing accounts.
While a client is connected to the executing environment and other shared inference hosts,
T3 discovers hosts that serve the same provider and saves them as fallback routes. If the
selected host is unreachable, rejects authentication, or reaches a temporary limit, a new
request can use another healthy host that serves the requested model. The agent and its
workspace stay on the executing environment. Keep at least one client connected to each
host when adding new fallback routes; saved routes remain available afterward.
T3 keeps a thread on the host that successfully handles its request after a switch. Each
host selects accounts independently, so a switch between hosts with multiple eligible
accounts may use a different account even when the same login is present on both.

Configure account pooling on the host. Turn on round-robin routing to distribute
requests across eligible accounts, or leave it off to use the first available account.
Session affinity keeps a conversation on its credential while available. The model
picker always shows normal Claude and Codex models. Traex remains a separate backend.

Routing is optional. Turn off **Use CLI proxy** to return to this provider's normal
T3 Code configuration. Standalone CLI configuration is unchanged.
After an upgrade, threads, scheduled tasks, and saved model choices that named an older
route or account pool use the normal Claude or Codex provider. They run through the proxy
only when **Use CLI proxy** is on for that provider.

Remove a provider login on its host, revoke one consuming environment, or turn
off sharing to revoke all remote grants. Remove the route in **Inference accounts** on the executing machine. Stopping hosting keeps the host's accounts
for the next start.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Claude Code also
compacts automatically. To see context usage, see
[commands and skills](./composer.md#commands-and-skills).

When you return to a large thread after Claude's prompt cache expires, a
**Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Keep** and keep the full
history for that message. The mobile app shows no chip: an eligible message sent
from it summarizes first. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

**Compact idle threads** in **Settings > Providers > Advanced** controls this for threads
over 200,000 tokens. Each Claude provider's settings can override it:

- **When you return** shows the **Compact** chip described above. This is the default.
- **Before the cache expires (beta)** tries to compact an idle thread shortly before its
  prompt cache expires, while the history is still cached.
  The compaction appears in the thread as a `/compact` turn sent by T3 Code.
  If the window is missed, such as when you enable this mode after the cache has
  expired or the server restarts before compaction runs, it falls back to
  **When you return**. Switch the chip to **Keep** to keep the full history for that message.
- **Never** skips idle compaction and Claude's resume prompt. **Auto-compact after**
  still applies, and you can still compact by hand.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Enabled installed Claude plugins,
and plugins synced from your claude.ai account, also contribute skills under
names such as `plugin:review`. Skills marked `disable-model-invocation` can
still be started by you. Invoke those one per message: Claude directly runs only
the last named skill and may try to start earlier ones through its Skill tool,
which refuses skills reserved for manual invocation.

## Task lists

To show Claude task lists in the web and desktop apps, add
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under **Variables** in the Claude instance's
**Environment** section in **Settings > Providers**. Each update shows as a Tasks
row in the thread; open it to see every step.

## Claude in Chrome

Claude threads can use the Claude in Chrome extension, which works in your own
Chrome with its sign-ins. T3 Code sessions load it only when asked: add `--chrome`
to **Launch arguments** in the Claude instance's settings in **Settings > Providers**.
It applies to sessions that start after you save. Set up the extension as you would
for Claude Code first; see Claude Code's [Chrome guide](https://code.claude.com/docs/en/chrome).

The instance must be signed in with `/login` on a direct Anthropic plan. Instances
that use an API key or a `claude setup-token` token don't get it, even with
`--chrome`, and neither do third-party providers such as Amazon Bedrock. Claude Code
doesn't support it in WSL.

## OpenRouter

Choose **Use existing Claude Code**. Set a separate config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in T3 Code. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in T3 Code. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.
