# Run in the cloud

Codex and Claude threads can run in the provider's own cloud instead of on one
of your machines. Pick **Codex Cloud** or **Claude Code cloud** under **Run on**
in the composer, next to your machines, before you send the first message. The
cloud entry follows the thread's provider. The work keeps running when your
computer sleeps, and you can follow it on [chatgpt.com/codex](https://chatgpt.com/codex)
or [claude.ai/code](https://claude.ai/code).

Like a machine, the run location is fixed once the thread starts. To move work
between the cloud and a machine, start a new thread.

## Set up

T3 Code uses the provider's CLI on the machine hosting your environment, signed
in with your subscription:

- **Codex Cloud** needs the Codex CLI signed in with ChatGPT and a
  [Codex Cloud environment](https://chatgpt.com/codex/settings/environments) for
  the repository. In **Settings → Providers**, set Codex's **Cloud environment**
  to the environment's ID or label. Run `codex cloud` on the host to list yours.
  Codex instances using T3 Code's managed ChatGPT sign-in do not offer it yet.
- **Claude Code cloud** needs Claude Code signed in with a claude.ai
  subscription. API keys and third-party providers such as Bedrock cannot start
  cloud sessions. Connect GitHub at claude.ai/code, or run `/web-setup` in
  Claude Code.

The cloud starts from your repository's remote at the thread's branch, not from
your local files. Push local commits first. Claude Code uploads the repository
instead when it has no GitHub remote it can clone.

## How a message runs

The thread shows a link to the cloud task as soon as it starts.

- **Codex Cloud** waits for the task to finish, then applies its changes to the
  thread's workspace. They appear in the diff like any other turn's changes, and
  you can revert them the same way. If they conflict with your local files, the
  turn fails and the task keeps its diff on chatgpt.com. Each message starts a
  new task, so include the context it needs.
- **Claude Code cloud** starts one cloud session for the thread, and later
  messages continue it. When your account supports waiting, the turn shows
  Claude's reply. Otherwise it ends once the session has your message, and
  Claude keeps working on claude.ai. Bring its branch back with
  `claude --teleport <session-id>` in a terminal.

**Stop** stops waiting. It does not cancel the cloud task, which keeps running;
the thread keeps its link.

## Limitations

Cloud agents work unattended in their own sandbox: they cannot ask you
questions, request approvals, or use T3 Code's tools, and the permission mode
does not apply to them. Messages take text only, the model is whatever the
cloud runs for your account, and conversations cannot be forked or rewound.
