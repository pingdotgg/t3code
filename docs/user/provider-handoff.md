# Continue A Thread With Another Provider

You can continue an existing thread with another configured provider or account from the model
picker in the message composer. Choose the destination provider and model, then send your next
message normally.

When the destination can resume the existing provider session, T3 Code keeps using that native
history. When it cannot—such as moving from Claude to Codex, or between isolated accounts—T3 Code
starts a fresh destination session and sends it a bounded handoff containing the recent
conversation and completed tool work. Your project, branch, worktree, permission mode, and T3 Code
thread stay the same.

The handoff is sent only with the first message to the new provider. Older history may be omitted
from very long threads to stay within provider input limits. The workspace remains the source of
truth for file changes already made.

If another provider does not appear in the picker, confirm that it is enabled, installed, and
authenticated in Settings. A server version that does not support provider handoff keeps existing
threads locked to their compatible provider group.
