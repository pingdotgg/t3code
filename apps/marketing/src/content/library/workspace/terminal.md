---
title: "Terminal history"
description: "Read and copy T3 Code terminal history, understand scrollback limits, reconnect to server-owned sessions, and troubleshoot fish startup."
updated: 2026-11-04
sources:
  - label: "Terminal history"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/terminal.md"
  - label: "Terminal runtime"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/terminal-runtime.md"
  - label: "Source control authentication and Git actions"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
  - label: "Theo on the shift away from terminal-centered work, 5:00"
    url: "https://www.youtube.com/watch?v=dLhcLqoff6k&t=300s"
faq:
  - question: "How much terminal history does T3 Code save?"
    answer: "T3 Code retains up to 5,000 lines and 8 MiB of scrollback per terminal on the environment server. It removes the oldest output when either limit is reached."
  - question: "How do I copy all terminal output in T3 Code?"
    answer: "Choose Select all in the T3 Code terminal context menu, then copy. This selects all retained output, which may exclude older output already removed by retention limits."
  - question: "Does T3 Code truncate new terminal output?"
    answer: "T3 Code does not truncate new terminal output. Its retention limits apply to history, including history restored after reconnecting."
  - question: "Why does fish behave differently in T3 Code?"
    answer: "T3 Code starts fish with no-query-term to avoid waiting for terminal replies. Set fish_features in the environment launching T3 Code if you need other flags or query-term."
---

T3 Code keeps terminal scrollback on the environment server so you can return to recent command output after reconnecting. Each terminal retains up to 5,000 lines and 8 MiB, with the oldest output removed when either limit is reached.

## Understand what terminal history preserves

The environment server owns terminal sessions and their retained output. Clients attach through the environment connection, including the desktop app. That design lets clients reconnect to or share a running session.

Treat scrollback as a recent working record. It helps you return to a failed command, inspect output that passed while you were elsewhere, or copy a diagnostic into a conversation. It is bounded, so preserve important results separately before later output displaces them.

Both limits apply independently. A command that produces many short lines can reach the line limit. A command that prints very large lines can reach the byte limit. T3 Code may shorten the beginning of a long line while enforcing retention. New live output is not truncated.

The same limits apply when reconnecting and restoring saved history. A client may display less scrollback than the server retains. A shorter visible history therefore does not establish that the command printed less output.

## Read scrollback without leaving terminal input

On web and desktop, use these keys while the terminal has focus:

| Action                           | Windows and Linux | macOS            |
| -------------------------------- | ----------------- | ---------------- |
| Read older output                | `Shift+PageUp`    | `Shift+PageUp`   |
| Read newer output                | `Shift+PageDown`  | `Shift+PageDown` |
| Jump to retained history's start | `Ctrl+Shift+Home` | `Cmd+Shift+Home` |
| Jump to latest output            | `Ctrl+Shift+End`  | `Cmd+Shift+End`  |

Full-screen terminal programs keep these navigation keys. If a full-screen program is active, expect it to receive them rather than forcing ordinary scrollback navigation.

The terminal context menu also has `Jump to latest`. Use it after reviewing earlier output to return to the current command position. That helps distinguish an old error from a command still producing output.

## Copy a failure with its surrounding output

1. Open the terminal context menu.
2. Choose `Select all`.
3. Copy the selected retained output.
4. Include the relevant command and failure context when asking an agent to investigate.

On macOS, `Cmd+A` selects the same retained output. Elsewhere, use `Ctrl+Shift+A`. On Windows and Linux, `Ctrl+A` still moves to the beginning of shell input.

Selection covers retained history. It cannot recover output removed after reaching a limit. For a long command, capture the relevant failure while it is still present. Include the first useful error and its context instead of assuming the final line explains the cause.

## Decide when you still need a terminal

Use the terminal when the task requires a command or its exact output. Host login commands are one example: GitLab authentication uses `glab auth login`, while Azure DevOps setup uses Azure CLI and its extension. Run these on the environment server that needs the credentials.

Use [source control](/learn/workspace/source-control) when you want to inspect a branch comparison, create a pull request, or review comments. Ask for a [visual reply](/learn/workspace/visual-replies) when a chart or annotated comparison communicates the result better than text output.

You can combine these views. Read the command output to verify a check, inspect the diff to understand the change, and review a visual result when appearance matters. Choose the surface that provides the evidence needed for that decision.

Theo describes his own move from terminal-based Git and inspection in [I'm done with terminals](/learn/videos/done-with-terminals). The broader [GUI versus terminal discussion](/learn/concepts/gui-vs-terminal) explains that workflow choice without requiring you to abandon command-line work.

## Fix fish startup and feature flags

T3 Code starts fish with `no-query-term`. This avoids startup waits for terminal replies and disables optional fish features that depend on those replies. Its exported `fish_features` also hides universal flags configured with `set -U fish_features`.

To preserve flags, include them in `fish_features` in the environment launching T3 Code. To enable terminal queries, include `query-term` there. Enabling queries can bring the startup wait back.

A shell export applies when you launch T3 Code from that shell. It does not configure a desktop app launched through the Dock or Finder. Check how you launched the app before concluding that the setting was ignored.

## Next steps

- Return to the [Git, terminal, and previews guides](/learn/workspace) to choose another inspection surface.
- Compare the terminal result with the [source-control diff](/learn/workspace/source-control) before accepting a code change.
