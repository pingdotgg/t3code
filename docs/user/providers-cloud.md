# Codex Cloud and Claude Code Cloud

Codex Cloud and Claude Code Cloud run a thread's messages in the provider's
cloud instead of on your machine. They are beta integrations and are disabled by
default. The work keeps running when your computer sleeps, and you can follow it
on [chatgpt.com/codex](https://chatgpt.com/codex) or
[claude.ai/code](https://claude.ai/code).

## Set up

Both use the provider's CLI on the machine hosting your environment, signed in
with your subscription account:

- **Codex Cloud** needs the [Codex CLI](https://developers.openai.com/codex/cli)
  signed in with ChatGPT (`codex login`) and a
  [Codex Cloud environment](https://chatgpt.com/codex/settings/environments) for
  the repository. Run `codex cloud` on the host to see your environments.
- **Claude Code Cloud** needs [Claude Code](https://code.claude.com/docs/en/quickstart)
  signed in with a claude.ai account (`claude auth login`). API keys and
  third-party providers such as Bedrock cannot start cloud sessions. Connect
  GitHub at claude.ai/code, or run `/web-setup` in Claude Code.

Open **Settings → Providers**, select the environment, and enable the provider.
For Codex Cloud, set **Cloud environment** to the environment's ID or label.
Then pick the provider in a thread's model picker.

The cloud starts from your repository's remote at the thread's current branch,
not from your local files. Push local commits first. Claude Code uploads the
repository instead when it has no GitHub remote it can clone.

## How a message runs

The thread shows a link to the cloud task as soon as it starts.

- **Codex Cloud** waits for the task to finish, then applies its changes to the
  thread's workspace. They appear in the diff like any other turn's changes, and
  you can revert them the same way. If the changes conflict with your local
  files, the turn fails and the task stays on chatgpt.com with its diff. Each
  message starts a new task, so include the context it needs.
- **Claude Code Cloud** starts one cloud session for the thread, and later
  messages continue that session. When your account supports waiting, the turn
  shows Claude's reply. Otherwise it ends once the session has your message, and
  Claude keeps working on claude.ai. Bring the session's branch back with
  `claude --teleport <session-id>` in a terminal.

**Stop** stops waiting. It does not cancel the cloud task, which keeps running;
the thread keeps its link.

## Limitations

Cloud agents work unattended in their own sandbox, so **Full access** is the
only [permission mode](./permission-modes.md) and there is no Plan mode. They
cannot ask you questions or use T3 Code's tools. Messages take text only, the
model is whatever the cloud runs for your account, and conversations cannot be
forked or rewound. Commit messages and thread titles use another provider.
