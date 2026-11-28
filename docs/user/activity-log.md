# Activity log

The activity log shows what an agent is doing during a turn—shell commands, file edits, searches, and tool calls—as expandable summaries in the conversation.

## Inspect tool calls

- Expand a summary group on web and desktop to inspect commands, tool inputs, status, and exit codes.
- Expand an individual tool call to view its output. Running commands stream live, showing the most recent output for long logs.
- Select **Open diff** on a file change to review the edit.

## Hide tool calls

Configure **Settings → Chat → Tool calls in chat** (web and desktop) or **Settings → Appearance → Tool calls in chat** (mobile) to reduce noise in the conversation. This setting applies per device or browser.

| Mode                   | Behavior                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Show all** (default) | Shows all tool calls and summaries.                                                                                                                       |
| **Hide successful**    | Shows a call while it runs and keeps it only if it fails.                                                                                                 |
| **Hide all**           | Hides every tool call and shows **Thinking** while the agent works.                                                                                       |
| **Zen**                | Also hides intermediate agent messages, showing only your prompt and the agent's final reply once the turn ends (plus any reply finished before a steer). |

Approvals, questions, and errors are always shown. On web and desktop, opening Find temporarily reveals hidden intermediate messages.

## Screen reader announcements

On web and desktop, configure **Settings → Chat → Screen reader announcements** to hear turn progress for the open thread (per device/browser):

- **Status only**: Announces when a turn starts, needs approval or input, and finishes.
- **Status and messages**: Also reads intermediate agent messages once complete (long messages are truncated). The final reply is not read automatically so you can read it yourself after hearing **Done**.
- **Everything**: Adds the current step (such as the command running); rapid steps may be skipped for newer ones.

Agent reasoning text is never read. Announcements follow actual agent activity regardless of **Tool calls in chat**.

### Screen reader window title

Turn on **Settings → Chat → Screen reader window title** to prefix the window title with the open thread's status (**Working**, **Needs approval**, or **Needs your input**), thread title, and project name. The status prefix clears when the turn ends.

> Note: This title is visible in your taskbar, window switcher, and shared screens, and time trackers that group by window title will count each status separately.
