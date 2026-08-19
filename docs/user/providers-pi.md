# Pi

T3 Code can use your existing Pi coding agent installation while keeping Pi's models, auth,
extensions, skills, context files, and native session history.

## Set Up Pi

1. Install Pi on the machine running the T3 Code server.
2. Run Pi once in a terminal and finish the provider login or API-key setup you normally use.
3. Open T3 Code Settings, enable Pi, and refresh the provider.

If `pi` is not on the server's `PATH`, set Pi's binary path to the executable. Provider environment
variables and launch arguments are also available for installations that need a custom agent
directory, endpoint, or model configuration.

## What Carries Over

T3 Code discovers the models reported by Pi and exposes their supported thinking levels. The
thinking picker marks Pi's current configured level as the default without overriding it. Threads
use Pi's native session files, so resume, rollback, and current-branch forks keep Pi's conversation
state. Extension dialogs appear in the T3 Code composer, and the composer context meter updates from
Pi's own context-window statistics after a response settles.

Pi skills appear in the composer's `$` menu. This includes user skills and project skills that Pi
loads for the current workspace; selecting one uses Pi's native skill expansion.

Pi's normal user extensions continue to load. T3 Code supplies its own session-aware `subagent`
tool so each child can be opened and continued as a T3 Code thread. Project-local extensions are
only loaded automatically when Pi is configured to always trust that project.

## Troubleshooting

- If Pi is unavailable, confirm that the configured binary runs on the server machine, then refresh
  the provider in Settings.
- If no models appear, open Pi directly and confirm its authentication and model configuration.
- If a project extension is missing, approve the project in Pi or configure standing project trust,
  then start a fresh provider session.
- If a project skill is missing from the `$` menu, approve the project in Pi and refresh the provider.
- The context meter appears after Pi returns its first usable token snapshot for the thread.
