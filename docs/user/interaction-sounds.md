# Interaction Sounds

T3 Code plays short interaction sounds for important thread transitions on web, desktop, and
mobile:

- **Completion:** a success cue plays when a turn started by you completes, even if another thread
  is open.
- **Input required:** a bloom cue plays when a thread begins waiting for your input or approval.

Completion sounds do not play for cached startup state, unchanged state, or background provider
work that was not started by a user message. Input-required sounds can still play for background
work so you know when an agent is blocked on your response.

## Completion Sound Setting

Completion sounds are enabled by default.

- On web and desktop, open **Settings** → **General** → **Completion sound**.
- On mobile, open **Settings** → **General** → **Completion Sound**.

Turning this setting off disables only the completion cue. The input-required cue remains enabled so
T3 Code can still alert you when an agent is blocked on your response.

The mobile setting is stored on that device. Changing it does not change the web or desktop setting.
