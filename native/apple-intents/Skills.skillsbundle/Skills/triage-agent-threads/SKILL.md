---
name: triage-agent-threads
description: "Check which T3 Code coding agent threads need attention, inspect thread status, stop a runaway agent, or organize threads by settling, snoozing, or pinning them."
---

# Triaging Coding Agent Threads

When the user asks what their coding agents are doing or wants to clean up threads:

1. To see threads waiting for approval, encountering errors, or actively running, call **List Attention Threads**.
2. To inspect one specific thread the user named or has onscreen, call **Get Thread Status**. If its answer starts with "Last synced", tell the user the status may be out of date.
3. To settle, unsettle, snooze, unsnooze, pin, or unpin a thread, call **Organize Thread** with the matching action. Archiving is done in the T3 Code app.
4. To halt an actively running agent turn, call **Stop Thread** (always confirm before stopping active work).
5. To jump directly into the conversation UI, call **Open Thread** or **Open Project**.
