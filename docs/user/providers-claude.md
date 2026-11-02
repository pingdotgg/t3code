# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Add another account

In **Settings > Providers**, add Claude and choose **Sign in with Claude Code**.
Name the account and continue to sign-in. Open the browser link, then paste the
code from Claude into T3 Code. You can sign in from another device when the
T3 Code environment runs remotely. To sign out, open that account's provider
settings.

Accounts added with **Sign in with Claude Code** share your Claude profile in
`~/.claude`, including settings, skills, plugins, agents, and `CLAUDE.md`. Changes
from any account, such as enabling a plugin or allowing a tool, apply to all
accounts. Each account keeps its own login, trust decisions, MCP servers, and
conversation history. Accounts added before this version start sharing too. Turn
off **Use your Claude profile** in an account's provider settings to give it a
profile of its own.

To reuse an installed CLI account, choose **Use existing Claude Code**. Leave
**CLAUDE_CONFIG_DIR path** empty to use the CLI's default configuration. For a
custom directory, sign in with `CLAUDE_CONFIG_DIR=/path/to/config claude auth login`
and enter that directory in the provider settings. Keep `HOME` unchanged so Claude
can find the system keychain.

For API keys, custom endpoints, and routers, choose **Use existing Claude Code**
and configure its **Environment variables**. Independent subscription accounts
use their own Claude login and ignore credential and endpoint overrides.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

## Account pools

With two or more Claude accounts, you can offer them as one. In **Settings >
Account pools**, tick the Claude accounts to share and turn on **Pool these
accounts**. The model picker then shows a single Claude entry in place of the
ticked accounts. Each turn runs on an account that still has usage left. If an
account reaches its usage limit mid-turn, the turn continues on another account,
and the thread's model picker shows the account that ran it.

A thread stays on its account while that account is available. Moving a thread to
another Claude account continues from a summary of the conversation, because each
account keeps its own history.

Pooled accounts stay in **Settings**, where you can still select them and where
**Settings > Providers** shows which pool each belongs to and when a limited account
is available again. To bring an account back into the model picker, untick it or
turn the pool off. Threads stay on the account that last ran them.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter. The meter is off by default; see
[commands and skills](./composer.md#commands-and-skills) to enable it. Claude Code
compacts automatically whether the meter is on or off.

When you return to a large thread after Claude's prompt cache expires, a
**Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Keep** and keep the full
history for that message. The cache lasts about an hour on a Claude
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

Use `$` in the composer to select a skill. Enabled installed Claude plugins also
contribute skills under names such as `plugin:review`. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## Task lists

To show Claude task lists in the web and desktop apps, add
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under **Variables** in the Claude instance's
**Environment** section in **Settings > Providers**. Each update shows as a Tasks
row in the thread; open it to see every step.

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
