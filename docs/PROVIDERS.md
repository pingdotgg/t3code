# AI providers in Continuum IDE

Continuum IDE drives each vendor's official agent with that agent's own sign-in. It does not
extract tokens, reuse browser cookies, or route your subscription through a third party.

| Agent              | Sign in                                            | Install                                               | Multiple accounts                        |
| ------------------ | -------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| OpenAI Codex       | In app (**Connect with ChatGPT**) or `codex login` | Managed by Continuum, or your own CLI                 | Yes (**Add Codex account**)              |
| Claude Code        | `claude auth login`                                | [Claude Code](https://claude.com/product/claude-code) | Yes, one `CLAUDE_CONFIG_DIR` per account |
| Google Antigravity | In app (**Sign in** with Google)                   | Managed by Continuum                                  | Yes, one managed profile per instance    |
| Cursor             | `agent login`                                      | [Cursor CLI](https://cursor.com/cli)                  | Via separate config                      |
| OpenCode           | `opencode auth login`                              | [OpenCode](https://opencode.ai)                       | Via separate config                      |
| Grok Build         | `grok login`                                       | [Grok Build CLI](https://x.ai/cli)                    | Via `GROK_HOME`                          |
| Kiro               | `kiro-cli login`                                   | [Kiro CLI](https://kiro.dev/docs/cli/)                |                                          |
| Pi                 | `pi` then `/login`                                 | [Pi](./user/providers-pi.md)                          |                                          |
| Muse Code          | `muse login`                                       | [Muse Code](https://dev.meta.ai/docs/muse-code)       |                                          |
| fx                 | `fx login`                                         | [fx](https://fx.sh)                                   |                                          |
| Any ACP agent      | Agent-specific                                     | [ACP registry](./user/providers-acp.md)               |                                          |

## Models

The model picker lists what each agent reports for your account; nothing is hard-coded per account.
Reasoning effort, context window, and speed controls appear only when the selected model reports
them. You can add custom model IDs per account in **Settings → Providers**.

## Accounts and limits

Each account is a provider instance with its own name, sign-in, and environment. When an account
reaches a usage limit, Continuum shows the provider's message; switch the conversation to another
account or agent from the model picker. Continuum never rotates accounts automatically.

## Connect with ChatGPT

**Connect with ChatGPT** uses the same flow as upstream T3 Code (Codex's ChatGPT sign-in with plan
sharing). If OpenAI does not accept it for this fork, use **an existing Codex login** instead:
install the Codex CLI, run `codex login`, and Continuum picks it up.

Detailed per-agent guides from upstream (they say "T3 Code"; the steps are the same in Continuum):
[Codex](./user/providers-codex.md), [Claude](./user/providers-claude.md),
[Antigravity](./user/providers-antigravity.md), [OpenCode](./user/providers-opencode.md),
[Kiro](./user/providers-kiro.md), [Pi](./user/providers-pi.md), [Muse Code](./user/providers-muse.md),
[fx](./user/providers-fx.md).
