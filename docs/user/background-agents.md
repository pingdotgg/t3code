# Background Agents

Providers can delegate work to background subagents that keep running after the
main response settles. T3 Code keeps that work visible so a thread never looks
finished while children are still active.

## What you see

- **Thread list.** A thread stays in the **Working** state while any of its
  background tasks are running, even when the main turn has completed. The row
  returns to ready only when the last task completes, fails, or is stopped.
- **Open thread (mobile).** A slim rail docks above the composer showing a
  spinner, how many subagents are working, and how long the oldest one has been
  at it. The rail appears the moment a subagent starts and leaves when the last
  one settles.
- **Background agents sheet (mobile).** Tap the rail to open a sheet listing
  each agent with its elapsed time and latest progress line. Recently settled
  agents stay listed with their outcome.

## Behavior notes

- Sending another prompt while background agents run is allowed — the rail is
  there so you know follow-up work is still changing files or running tests.
- If the provider session stops, errors, or is interrupted, its background
  tasks end with it and the indicator clears.
