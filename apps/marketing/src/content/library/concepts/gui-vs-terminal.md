---
title: "Why run coding agents in an app instead of a terminal"
description: "See why Theo moved agent work into apps, how T3 Code organizes projects and threads, and when to use its terminal alongside the interface."
updated: 2026-11-04
sources:
  - label: "Theo explains his terminal background and app workflow"
    url: "https://www.youtube.com/watch?v=dLhcLqoff6k&t=240s"
  - label: "Theo explains why he built T3 Code"
    url: "https://www.youtube.com/watch?v=uLGxb4F3SyI&t=0s"
  - label: "Working with threads"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Terminal history"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/terminal.md"
  - label: "Source control"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
  - label: "Architecture"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md"
faq:
  - question: "Why use T3 Code instead of a terminal?"
    answer: "T3 Code gives you a shared interface for agent conversations, project work, and source control. Theo Browne says this style helps him manage several tasks and review their results."
  - question: "Can I still run shell commands in T3 Code?"
    answer: "T3 Code includes terminals on the environment running your work. You can use an app workflow and still run commands yourself."
  - question: "Does T3 Code replace Claude Code or Codex CLI?"
    answer: "T3 Code connects to agent runtimes such as Claude Code and Codex. Its app interface changes how you direct and follow the work."
  - question: "Where is terminal history stored?"
    answer: "T3 Code keeps retained terminal history on its environment server. Each terminal keeps up to 5,000 lines and 8 MiB, removing older output when either limit is reached."
---

T3 Code gives you an app interface for agent conversations, projects, source control, and terminals. Use it when following several tasks and reviewing their results benefits from a shared view. Theo Browne's case for apps centers on that workflow and the friction he encountered managing it through terminal sessions.

## Why did Theo move away from terminal-first agent work?

In [I'm done with terminals](/learn/videos/done-with-terminals), Theo starts by describing his long history with terminals, remote shells, and session managers. His argument comes from using those systems for agent work, then finding a different interface more comfortable.

At 4:00, he describes the appeal of an agent manager showing projects and their threads. At 7:01, he focuses on screenshots, selecting text, readable output, and moving between tasks. At 8:01, he explains the effort of remembering where work lives across several terminal panes.

These are Theo's experiences and preferences. They give you questions to ask about your own workflow: can you find the right task, inspect its result, and return to another project without rebuilding the map in your head?

His account in [T3 Code broke me](/learn/videos/t3-code-broke-me) adds another reason for building T3 Code. He wanted an open-source alternative that he and the team could change themselves. That explains the project's motivation without making performance claims about competing apps today.

## When does an app help with agent work?

The useful distinction is the job you are doing at that moment:

| Your immediate task                         | A useful surface                      |
| ------------------------------------------- | ------------------------------------- |
| Follow a conversation and its tool activity | The T3 Code thread                    |
| Move between independent tasks              | The thread list and project selection |
| Inspect changes from the latest agent turn  | The Diff pane                         |
| Review changes across the branch            | The branch comparison                 |
| Run a command yourself                      | A terminal                            |

This is a suggested division of work, not a rule that requires you to abandon an existing editor or shell. T3 Code's interface can organize agent work while you keep familiar commands available for inspection and execution.

For a first trial, choose a task whose result you understand. Ask the agent to make a bounded change, inspect its activity, and review the diff. Then decide whether the interface reduces effort in a way that matters to you.

## How do threads replace the task map in your head?

T3 Code's thread guide recommends a new thread for a separate task. Choose `New worktree` when the change needs a separate branch and working directory. This makes the task boundary explicit before an agent starts editing.

You can search threads from the command palette by title, branch, pull request, or project. Settling finished work moves it out of the active list without deleting the conversation. These controls help you manage what needs attention and what you want to revisit.

A thread also survives provider process exits. You can therefore think in terms of the work and its saved history, rather than only the current process displaying output. [What T3 Code is](/learn/start/what-is-t3-code) explains that broader product model.

## Can you keep using the terminal?

T3 Code includes terminals whose processes and files belong to the execution environment. The app workflow still lets you run a command yourself when that is the clearest way to inspect or change something.

Terminal history is retained on the environment server, subject to limits. Each terminal keeps up to 5,000 lines and 8 MiB of scrollback. T3 Code removes the oldest output when either limit is reached. A client can display less history than the server retains.

For long output, distinguish the current command from saved scrollback. New terminal output is not truncated by those retention limits, but older output can disappear from retained history. Read [terminal history](/learn/workspace/terminal) for navigation and copying controls.

## How do you review work without switching apps?

T3 Code's turn diff shows the turn's own work. If a turn pulls, merges, or rebases, Git's incoming changes are left out of that view. Use the branch comparison when you need everything changed against the base branch.

This distinction matters whether you prefer a GUI or terminal. A readable diff answers only the comparison you chose. Confirm that comparison before deciding a task is ready.

Start with one task and one review. Theo's preference for managing several tasks does not create a requirement to run more agents than you can assess. Add concurrency when you have independent work and a clear way to review each result.

## Next steps

Read [the source-control guide](/learn/workspace/source-control) and [terminal history](/learn/workspace/terminal) for the controls used during review.

Return to [Ideas behind T3 Code](/learn/concepts), or [download T3 Code](/download) to try the workflow with an agent you already use.
