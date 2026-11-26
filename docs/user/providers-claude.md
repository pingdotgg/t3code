# Claude

T3 Code drives your Claude Code installation, login, skills, and plugins. See [provider setup](./install.md#providers) for initial installation.

## Multiple accounts and presets

Isolate separate Claude accounts or router presets with distinct `CLAUDE_CONFIG_DIR` directories:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add a second Claude instance in **Settings → Providers** (or **Add Claude account** on mobile) pointing **CLAUDE_CONFIG_DIR path** to `~/.claude_personal` (leave empty for the default directory). Always use `CLAUDE_CONFIG_DIR` rather than `HOME` so system keychain paths stay intact.

- Existing threads can only switch between Claude instances sharing the same config directory.
- Put API keys and endpoint overrides in **Environment variables** (not **Launch arguments**).
- Paths in `--settings` and `--append-system-prompt-file` expand `~` to the server's home directory; other relative paths resolve from the thread's workspace.

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

## Project trust

A project folder's Claude Code configuration can make Claude Code run things by itself, with no approval request: [hooks](https://code.claude.com/docs/en/hooks) and helper commands (`apiKeyHelper`, `proxyAuthHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`) in `.claude/settings.json` and `.claude/settings.local.json`, the servers in `.mcp.json`, and the environment variables under `env`. They run on the environment's machine with your permissions.

T3 Code asks once per project whether you trust its Claude Code settings, the way Claude Code asks when you first open a folder. A Claude thread or draft in a project that names any of these shows the question above the composer: **Review** lists what the files hold now, and **Trust project** records your answer. Sending messages does not wait for it. **Claude Code settings** in the project's settings shows the same list and can **Trust** or **Revoke**.

- **Scope**: Trust is kept on the environment, not in the repository, and covers the project's folder and every worktree thread of it. You are not asked again when the settings change, for example after a pull. A project that names none of these has nothing to trust and never asks.
- **Trusted**: Claude runs on the project's folder exactly as Claude Code would.
- **Full access**: A thread in **Full access** runs everything without asking, trusted or not.
- **Not trusted, below Full access**: The thread starts without the project's hooks, helper commands, MCP servers and environment variables, and says so in the conversation. The rest of the two settings files is left out too, except their deny and ask permission rules: allow rules, the default mode, model and plugin settings in them do not apply. `CLAUDE.md` and the other memory files, rules files, commands, skills and agents still apply, and so do your own Claude Code user settings and hooks.
- **Outside a thread**: Generated commit messages, pull request text and branch names, and the composer's list of slash commands, have no permission mode. They follow trust alone: in a trusted project Claude Code reads the folder as it is, otherwise it leaves out the same things. Plugin commands a project enables in its own settings show in the composer once the project is trusted.
- **When it applies**: Trusting and revoking apply when the next Claude session of a thread starts.
- **Who can trust**: A client that can use the terminal (`terminal:operate`). Agents never trust a project. An administrator can stop projects from being trusted with [`claudeProjectHooks`](./managed-policy.md#other-capabilities).

An untrusted session reads its project configuration from a folder T3 Code writes for it. Claude Code runs your own hooks in that folder and names it in `CLAUDE_PROJECT_DIR`. The project's files are linked into it, so `./scripts/check.sh` and `"$CLAUDE_PROJECT_DIR"/scripts/check.sh` still find the project's script, with two differences:

- It is not a Git repository. A hook of yours that runs `git` in its working directory or in `CLAUDE_PROJECT_DIR` fails there; the hook's input still names the session's real folder as `cwd`.
- Where the machine cannot create links, as on Windows without developer mode, the project's files are not there, and commands, skills and agents are copies taken when the session started.

## Claude in Chrome

To use the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome) in T3 Code threads, add `--chrome` to **Launch arguments** in the Claude instance settings (applies to new sessions). Requires a direct Anthropic `/login` plan—not supported with API keys, `setup-token`, Bedrock/Vertex, or WSL.

## OpenRouter and local routers

Create a separate Claude instance with its own config directory (e.g. `~/.claude_openrouter`, after running `/logout` if it had a cached Anthropic login) and set **Environment variables**:

| Variable               | Value                                    |
| ---------------------- | ---------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`              |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key (mark Sensitive) |
| `ANTHROPIC_API_KEY`    | Explicitly empty                         |

Add unlisted OpenRouter models via **Add custom model** in the instance settings. See the [OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) or [Claude Code Router](https://github.com/musistudio/claude-code-router) for local router setup.
