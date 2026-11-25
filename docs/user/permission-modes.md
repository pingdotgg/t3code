# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread. A new thread names its mode under the composer. In a thread
on your default mode, open the model picker and choose **Permissions** at its bottom, or press
`mod+shift+a`. A thread on another mode shows the mode next to the model.

Set the default for new threads in **Settings → Threads → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

An administrator can cap the modes available on a machine with a
[managed policy](./managed-policy.md#permission-modes); modes above the cap show who manages them.

Below **Full access**, T3 Code asks you before one of its own tools acts outside the thread with
your login: opening a pull request, editing, commenting on, reviewing or merging one, rerunning
its checks, and creating, commenting on or changing the state of an issue. The request says what
will be done to what, such as "Merge pull request #5", with the repository and the tool that
asks, and says so when the repository is not the one your thread's project is a checkout of.
**Approve** lets that one call run; **Decline** does nothing. You are asked each time: there is
no "always allow" for these requests, and Plan mode asks too. An approval is for the call as it
was asked: if the agent then asks for something else, you are asked again. In **Full access**
these tools run without asking, as commands and edits do.

When opening a pull request would push the branch and the push would run one of the repository's
Git hooks (`pre-push` or `reference-transaction`, as a project with husky has), the same request
names the branch and the hooks too: the hook files, and any hook set up in Git's configuration
(`hook.<name>.command`, which Git 2.54 and later run). Approving pushes and runs them. That
covers the contents of the files and the commands the request names: if one of them changes,
you are asked again. A change made in the moment between T3 Code's last look and Git starting
the hook is not caught. With husky 9 and Vite+ that is the hook's script, such as
`.husky/pre-push`, along with the two files they generate to start it. It does not cover what
those go on to run or read, such as a package script or another file a hook sources
(`.husky/_/husky.sh` with husky 8), so a change there is not asked about.

With Claude and Codex the request appears in T3 Code and the tool waits for your answer there.
An agent of another provider is told that T3 Code could not ask you and does nothing: do the
action yourself, or switch the thread to **Full access**. An MCP client from outside T3 Code has
no thread to ask you in, so it needs full access for these tools.

These requests are for T3 Code's own tools only. An agent that runs `git push` or a command such
as `gh pr create` itself, in its own shell, goes through its provider's approval for commands as
the table above describes, and the repository's hooks run with that command.

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task. Subagent approval requests appear in
the parent conversation with the subagent's name, so you can respond without switching threads.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, Cursor, Grok, Antigravity, and fx; providers without
an equivalent, including OpenCode, fall back to asking. On Grok and Antigravity, actions their review
does not approve come to you for approval. On fx, prompts it still sends also come to you.

Antigravity offers **Auto** only when your Antigravity sign-in provides its Auto mode; some accounts,
including some personal Google accounts, do not. Without it, an Antigravity thread already set to
**Auto** runs in **Supervised**.

Muse Code offers only **Supervised** and **Full access**. A Muse thread already set to another mode
runs in **Supervised**.

T3 Code offers no **Auto-accept edits** for fx, and **Full access** only with fx 0.0.14 or later. An fx
thread set to a mode its fx lacks runs in **Supervised**.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; T3 Code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

In **Full access**, commands that Codex's dangerous-command check would ask about run without
asking. Codex still asks before network access its managed network settings don't allow, unless
you already allowed commands for the session.

Claude can still ask in **Full access** when its settings disable bypass permissions or require
approval for an action. Dangerous-removal safety checks in bypass mode reject the command with
the original warning. Claude can use a safe rewrite when the warning supplies one; otherwise it
continues without the removal and tells you what it skipped.
While a Claude approval is pending, type a text reply to decline that request and give feedback
directly to the agent that asked, including a subagent. Other pending requests stay unanswered.

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

Kiro offers only **Supervised** and **Full access**. In **Supervised** Kiro also asks you to
review a turn's file changes. See [Kiro permissions](./providers-kiro.md#permission-modes).

See the [provider guides](./install.md#providers) for setup and provider-specific limits.
