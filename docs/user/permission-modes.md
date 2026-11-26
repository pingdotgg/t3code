# Permission modes

Permission modes control when an agent must ask for your approval before running commands or editing files. Set the mode per thread from the composer (`mod+shift+a` or the model picker's **Permissions** menu).

Configure the default for new threads in **Settings → Threads → New threads → Permissions** (default: **Full access**; projects can override). Administrators can cap available modes with a [managed policy](./managed-policy.md#permission-modes).

| Mode                  | Behavior                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                          |
| **Auto-accept edits** | Approves file edits automatically; commands and other actions may still ask.              |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about risky ones. |
| **Full access**       | Runs commands and edits without approval prompts.                                         |

Permission modes never stop an agent from asking clarifying questions. Subagent approval requests appear in the parent conversation with the subagent's name so you can approve without switching threads.

## Git push hooks below Full access

When an agent below **Full access** opens a PR using T3 Code's built-in pull request tool and the push would execute local Git hooks (`pre-push`, `reference-transaction`, or `hook.<name>.command`), T3 Code prompts you every time—naming the branch and hook files/commands—before pushing.

- Declining cancels the push. There is no "always allow" option, and Plan mode prompts too.
- Providers that can't show this prompt push without running hooks and inform the agent.
- Direct shell commands (`git push`, `gh pr create`) follow the provider's normal command approval rules instead.

## Provider differences

Providers enforce permissions differently, and some read-only actions proceed even in **Supervised**:

- **Auto mode**: Supported by Codex, Claude, Cursor, Grok, Antigravity (account-dependent; falls back to Supervised if unavailable), and fx. Providers without an equivalent (including OpenCode) fall back to asking.
- **Claude**: In **Auto**, asks about actions its review leaves open (unavailable if disabled in Claude settings or by the model). In **Full access**, Claude's own settings can still require approval or block dangerous removals. While an approval is pending, typing a reply declines it with feedback directly to that agent or subagent.
- **Codex**: In **Full access**, skips dangerous-command prompts, though managed network restrictions can still prompt unless commands were allowed for the session. Offers only the modes your organization's managed requirements allow: without `danger-full-access`, there's no **Full access**, and threads already on it fall back to Supervised (pick an offered mode if `read-only` is also ruled out).
- **Grok**: No **Auto-accept edits** (falls back to Supervised). File approvals offer session-wide allow; command approvals do not.
- **fx**: No **Auto-accept edits**; **Full access** requires fx 0.0.14+ (otherwise falls back to Supervised).
- **Muse Code & Kiro**: Only **Supervised** and **Full access** (other modes fall back to Supervised). In Supervised, Kiro also asks you to review turn file changes; see [Kiro](./providers-kiro.md#permission-modes).
- **Antigravity**: May still send native approval prompts in **Full access**.
- **ACP Registry agents**: T3 Code answers their approval requests according to the selected mode; see [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

See the [provider guides](./install.md#providers) for provider-specific setup and limits.
