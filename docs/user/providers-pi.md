# Pi

T3 Code can use your existing Pi coding agent installation while keeping Pi's models, auth,
extensions, skills, context files, and native session history.

## Set Up Pi

1. Install Pi 0.80.5 or newer on the machine running the T3 Code server.
2. Run Pi once in a terminal and finish the provider login or API-key setup you normally use.
3. Open T3 Code Settings, enable Pi, and refresh the provider.

If `pi` is not on the server's `PATH`, set Pi's binary path to the executable. Provider environment
variables and launch arguments are also available for installations that need a custom agent
directory, endpoint, or model configuration. T3 Code rejects launch arguments that change Pi's
execution mode or select a session because T3 owns those parts of the process lifecycle.

## What Carries Over

T3 Code discovers the models reported by Pi and exposes their supported thinking levels. The
thinking picker marks Pi's current configured level as the default without overriding it. Threads
use Pi's native session files for resume and rollback. Thread forks use T3 Code's portable
conversation context to start a fresh Pi session instead of cloning Pi's active session. Extension
dialogs appear in the T3 Code composer, and the composer context meter updates from Pi's own
context-window statistics after a response settles.

Pi skills appear in the composer's `$` menu. This includes user skills and project skills that Pi
loads for the current workspace; selecting one uses Pi's native skill expansion.

Pi loads its normal user and project extensions. Blocking `select`, `confirm`, `input`, and `editor`
dialogs work in T3 Code. Notifications appear in the work log. Pi terminal decoration such as
titles, status lines, and widgets does not have a T3 Code equivalent.

## Permission Modes

T3 Code applies the composer permission mode through Pi's blocking tool hook:

- **Supervised** asks before commands, file changes, and extension tools. Read-only tools continue.
- **Auto-accept edits** allows Pi's edit and write tools, but asks before commands and extension
  tools.
- **Full access** allows tools without T3 Code approval prompts.

The **Auto** option is not shown for Pi because Pi does not expose an AI approval reviewer.
Threads that already stored Auto before Pi support was added behave and display as Supervised.

Changing the mode restarts the Pi provider session and resumes the same native conversation. The
policy covers Pi tool calls; it is not an operating-system sandbox, and code that a trusted Pi
extension runs outside a tool call remains governed by Pi's own extension trust model.

T3 Code's `delegate_task` tool creates durable child threads in the shared subagent UI. If the user
installs Pi's example `subagent` extension, T3 Code also shows its task progress and results in that
UI. Pi runs those children without a session, so they cannot be opened or resumed as T3 Code
threads.

## Troubleshooting

- If Pi is unavailable, confirm that the configured binary runs on the server machine, then refresh
  the provider in Settings.
- If no models appear, open Pi directly and confirm its authentication and model configuration.
- If discovery cannot complete, T3 Code keeps Pi available with the `Pi default` model. Start a
  thread to let the interactive Pi session handle any startup prompt.
- If a project extension is missing, approve the project in Pi, then start a fresh provider session.
- If a project skill is missing from the `$` menu, approve the project in Pi and refresh the provider.
- The context meter appears after Pi returns its first usable token snapshot for the thread.
