# Cloud runs

Choose **Run on** above the composer to run a thread in Codex Cloud or Claude
Code cloud. Each provider uses your subscription. The destination stays fixed
once the thread starts; start a new thread to move work between cloud and a machine.

## Codex Cloud

Sign in to the Codex CLI with ChatGPT on the machine hosting your T3 environment.
T3 uses that account for cloud access. Codex instances using T3's managed
ChatGPT sign-in do not offer cloud runs yet.

Choose **Run on → Codex Cloud**, then select an environment. T3 remembers the
choice per project and account. To create one inside T3:

1. Select **Create environment**, name it, and choose connected GitHub repositories.
2. Select **Get started**. T3 opens a separate setup draft and preserves
   your original prompt. Send the setup message to let Codex prepare and test the environment.
3. When setup is done, select **Publish environment** above the composer in the
   setup conversation. **Edit environment** shows its configuration first. These
   controls appear only in setup conversations, not in ordinary cloud threads.
4. Return to your original draft and choose the published environment.

A published environment supplies repositories and a prepared filesystem to new
cloud tasks. Messages in the same T3 thread continue the same cloud conversation,
with streamed replies, tool activity, questions, and approvals. Work remains in
its cloud filesystem; it is not automatically applied to your machine.

Older Codex environments continue to use the CLI task workflow: each message
starts a new task, waits for completion, and applies its diff to your local
workspace. Push local commits before using that workflow. Conflicts leave the
task's diff on chatgpt.com. **Stop** stops waiting for a legacy task without
cancelling it.

## Claude Code cloud

Claude Code must be signed in with a claude.ai subscription. Connect GitHub at
claude.ai/code or run `/web-setup` in Claude Code. API keys and third-party providers
such as Bedrock cannot start cloud sessions.

The first message starts a cloud session and later messages continue it. If your
account supports waiting, T3 shows Claude's reply; otherwise it ends once the
session accepts the message, and Claude keeps working on claude.ai. Bring its
branch back with `claude --teleport <session-id>` in a terminal.

Claude cloud and legacy Codex tasks work unattended and accept text only. They
cannot use T3's local tools or ask questions through T3. Stopping the T3 turn
stops waiting; the remote task keeps running.
