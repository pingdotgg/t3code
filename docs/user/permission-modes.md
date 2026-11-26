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

## T3 Code's own tools below Full access

Below **Full access**, T3 Code asks you before one of its own tools acts outside the thread with your login: opening, editing, commenting on, reviewing or merging a pull request, rerunning its checks, and creating, commenting on or changing the state of an issue. A thread set to Full access is still asked in Plan mode and under an administrator's lower limit.

- The request names the action, its target, the repository and the tool, and says when the repository is not your project's. Names from the agent or the repository, such as a branch, are quoted, with any character a screen would hide written out. It does not show the text of an edit, a comment or a review.
- Opening a pull request names the branch and its commit, the base and, when the branch has to be pushed first, the remote, its address and the Git hooks the push would run (`pre-push`, `reference-transaction`, or `hook.<name>.command`). A private pull request is pushed to the repository's private companion. Merging a stack lists every pull request it would merge and its commit.
- **Approve** runs that one call; **Decline** does nothing. There is no "always allow". The agent waits for your answer for as long as you take: the request has no time limit, and is still there after you close and reopen the app.
- The request belongs to the turn that asked. Stopping the agent, or the turn ending, cancels it and nothing is done. Archiving the thread declines it. If T3 Code restarts while it is open, the request expires and the agent has to ask again.
- If what the request named has changed by the time you answer (a new commit, edited hooks, another pull request in the stack, another failed check), nothing is done. No new request appears by itself: the agent is told to call the tool again, and that call asks you about what is there now.
- A hook approval covers the hook files and commands the request names, not what they go on to run or read, such as a package script. A change in the moment between T3 Code's last look and Git starting is not caught.
- Rerunning checks names each check it would rerun. A push names every address it goes to; one too long to show in full is not asked about, and the agent is told to leave it to you.
- The request appears in the thread whichever provider the agent runs on. Claude, Codex and agents that pass T3 Code's question on to it simply wait. Other agents cannot hold a tool call open for long, so after a short while the agent is told you have not answered yet and asks again; the request itself stays where it is, and its step in the timeline reads as still under way. An MCP client from outside T3 Code needs full access for these tools.
- Some agents ask about tool calls themselves. With Kiro and Pi you see only T3 Code's request for these tools; other agents that ask on their own show their prompt first and T3 Code's request after it.
- T3 Code asks in the same way before an agent uploads a file to a page in the browser preview, when the file is not in one of the thread's folders and is not one of its attachments. The request names the file, as the path it really is after following any links, and the site it would go to. If the page is on another site by the time you answer, nothing is uploaded.
- A call for a linked environment is asked about in the thread that made it, and names that environment. The linked environment says what the call would do there and acts only on your approval of exactly that. Both environments need a version of T3 Code that does this; otherwise the call is refused.
- Direct shell commands (`git push`, `gh pr create`) follow the provider's normal command approval rules instead.

## Provider differences

Providers enforce permissions differently, and some read-only actions proceed even in **Supervised**:

- **Auto mode**: Supported by Codex, Claude, Cursor, Grok, Antigravity (account-dependent; falls back to Supervised if unavailable), and fx. Providers without an equivalent (including OpenCode) fall back to asking.
- **Claude**: In **Auto**, asks about actions its review leaves open (unavailable if disabled in Claude settings or by the model). In **Full access**, Claude's own settings can still require approval or block dangerous removals. While an approval is pending, typing a reply declines it with feedback directly to that agent or subagent.
- **Codex**: In **Full access**, skips dangerous-command prompts, though managed network restrictions can still prompt unless commands were allowed for the session.
- **Grok**: No **Auto-accept edits** (falls back to Supervised). File approvals offer session-wide allow; command approvals do not.
- **fx**: No **Auto-accept edits**; **Full access** requires fx 0.0.14+ (otherwise falls back to Supervised).
- **Muse Code & Kiro**: Only **Supervised** and **Full access** (other modes fall back to Supervised). In Supervised, Kiro also asks you to review turn file changes; see [Kiro](./providers-kiro.md#permission-modes).
- **Antigravity**: May still send native approval prompts in **Full access**.
- **ACP Registry agents**: T3 Code answers their approval requests according to the selected mode; see [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

See the [provider guides](./install.md#providers) for provider-specific setup and limits.
