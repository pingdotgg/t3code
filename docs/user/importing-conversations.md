# Importing conversations

T3 Code can import visible user and assistant messages from Cursor, Claude Code,
Codex, and Grok into an existing primary project.

Open **Import conversations…** from a project menu or the command palette. On
mobile, open the import action from the home screen. Discovery runs on the T3
server host, so the provider history must be available on that machine. T3 only
shows conversations whose provider workspace exactly matches the selected
project.

Imported conversations are snapshots. T3 preserves the provider's native
resume state when it is available; otherwise the imported thread is kept as a
transcript-only thread. Re-importing a source conversation is safe and does not
create a second thread.
