# Cursor

T3 Code drives the Cursor CLI (`cursor-agent`) on the connected environment. With a remote
environment, its Cursor login applies, not the setup on your desktop or phone.

Cursor support is off by default. Turn it on in **Settings** → **Providers**.

## Setup

1. Install the Cursor CLI on the environment's machine:

   ```bash
   curl https://cursor.com/install -fsS | bash
   ```

2. Log in with `cursor-agent login` (the CLI may also call this `agent login`).
3. In T3 Code, open **Settings** → **Providers** and enable Cursor.

T3 Code requires a Cursor CLI from 2026.04.08 or newer. It checks the version before loading
models or starting work; if the check fails, update the CLI with `cursor-agent update` and
refresh the provider status.

If `cursor-agent` is not on the PATH T3 Code sees, set its full path in the provider settings.

## What works

- Model selection, including per-model options such as reasoning level, context window, fast mode,
  and thinking, switched in-session from the model picker.
- Streaming responses with the model's reasoning shown separately when the CLI reports it.
- Plans and to-do lists the agent creates appear as structured plans in the thread.
- Permission modes, within what the Cursor CLI can enforce. **Full access** approves everything.
  **Auto** and **Accept edits** match Cursor's own behavior: safe commands run, risky commands
  stop for your approval, and file edits inside the workspace apply without prompting.
  **Supervised** runs Cursor in its read-only Ask mode: the agent reads and answers, and proposes
  changes instead of making them — switch to another mode when you want it to act.
- Choosing **Allow always** on a command approval is remembered by Cursor itself, in the
  environment's `~/.cursor` configuration, so it applies to every Cursor session on that machine.
- Questions the agent asks (multiple choice) appear inline in the conversation.
- Image attachments. Other file attachments are not sent to Cursor.
- File edits are checkpointed as they happen, so restore points exist mid-turn.
- Slash commands the CLI advertises appear in the composer's slash menu.
- Threads resume across T3 Code restarts through Cursor's own session history.

## Known limitations

- The Cursor CLI does not report token usage, so the context-window meter stays empty for Cursor
  threads and the Usage page does not include Cursor activity.
- A stalled turn is cancelled automatically after ten minutes without activity (thirty while a
  tool runs); the thread stays usable and shows what happened.
- Running several Cursor provider instances shares one `~/.cursor` login and command allow list
  between them.
