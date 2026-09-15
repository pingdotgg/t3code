# Voice history

Voice keeps a durable record of your voice sessions so a conversation is not lost when the
session ends, the connection drops, or you reload the app. The full transcript, the actions
voice took on your behalf, and what came of them survive and can be reviewed, exported, or
deleted afterwards.

## What is saved

For each voice session, chronological entries are kept on your device:

- **Transcript.** Every spoken utterance, labeled by speaker (you or the assistant), in order,
  with the same utterance identity the live panel shows.
- **Actions and outcomes.** Tool calls voice made: which thread, project, environment, or UI
  control it targeted, whether the action was acknowledged, dispatch identifiers and sequence
  for work it started or continued, the target session's status and last error, and control
  state for UI actions (for example, a control that was disabled). Direct commands from the
  fast-command path are recorded the same way.
- **Navigation.** Which thread was opened in your window, and whether the router confirmed the
  landing.
- **Errors and timing.** Errors that surfaced and the timing marks of the session's key events.

Not saved: audio, credentials or tokens, raw thread contents, and model reasoning. Tool records
carry bounded identifier and outcome fields only, so the history can answer "what did voice do
and why did it fail" without duplicating your threads.

## Where it lives

History is stored locally in the app that ran the session (browser storage for web, the
desktop app's storage for desktop). It is never synced to the server, and each client only
sees the sessions it witnessed. Web and desktop share saved history only when they resolve to
the same browser profile origin; storage partitions can be separate, and the mobile app keeps
its own. Retention is bounded: the most recent sessions are kept, older ones are deleted
automatically as new ones arrive.

## Reviewing, exporting, and deleting

Open the voice panel and expand **History** to see saved sessions with their start time,
length, and entry count. From there:

- **Delete** removes one saved session.
- **Export history** downloads every saved session as a JSON file.
- **Clear history** deletes all saved sessions.

Clearing and deleting are disabled while a voice session is live; end the session first.
