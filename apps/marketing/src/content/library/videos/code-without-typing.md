---
title: "How I code without typing"
description: "See how Theo adapts his T3 Code workflow with dictation, mobile access, clear task boundaries, and fewer manual steps between a problem and a reviewed result."
updated: 2026-11-04
sources:
  - label: "Theo Browne: How I Code Without Typing"
    url: "https://www.youtube.com/watch?v=NvVbCqDgfCs"
  - label: "Keybindings (docs/user/keybindings.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md"
  - label: "Messages and mobile voice input (docs/user/composer.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Working with threads (docs/user/thread-sidebar.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Remote access (docs/user/remote-access.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "Source control (docs/user/source-control.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
  - label: "Portable handoffs (docs/user/portable-handoffs.md)"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md"
faq:
  - question: "Is Theo dictating source code in How I code without typing?"
    answer: "Mostly, no. Theo dictates tasks and desired outcomes, then uses agents through T3 Code to investigate, implement, and verify the work."
  - question: "Do I need Theo's microphone to use T3 Code?"
    answer: "No. The microphone in the video is part of Theo's personal dictation setup. T3 Code accepts text prompts and does not require that equipment."
  - question: "Can I start another T3 Code task while the first runs?"
    answer: "Yes. On web and desktop, T3 Code can start a new thread in the background and leave you in a fresh composer. Current shortcuts are listed in Settings → Keybindings."
video:
  id: "NvVbCqDgfCs"
  title: "How I Code Without Typing"
  durationSeconds: 2302
  chapters:
    - time: "0:00"
      label: "Adapt a workflow when typing becomes difficult"
    - time: "4:02"
      label: "Speak intent instead of source syntax"
    - time: "6:00"
      label: "Use the phone as another work surface"
    - time: "8:00"
      label: "Make dictation practical around other people"
    - time: "12:00"
      label: "Reduce terminal and navigation friction"
    - time: "14:00"
      label: "Give the agent the whole transfer task"
    - time: "18:02"
      label: "Request an isolated experimental build"
    - time: "20:00"
      label: "Delegate tedious computer interactions"
    - time: "23:01"
      label: "Expand where the agent enters and finishes"
    - time: "29:01"
      label: "Start work without leaving the composer"
    - time: "32:01"
      label: "Bring pull request review into the app"
    - time: "34:01"
      label: "Let the agent retrieve relevant context"
---

T3 Code is part of the workflow Theo adapts when a hand injury makes typing and app switching difficult. He uses dictation, mobile control, and broader task requests to reduce the manual steps around development. The video matters for users who want less keyboard work and clearer handoffs between a problem, agent execution, and a result they can inspect.

## What Theo covers: describe the task instead of speaking code

At 0:00, Theo explains the personal constraint behind the video. The problem extends beyond typing speed. Familiar actions such as switching applications and copying text also become uncomfortable.

At 4:02, he demonstrates why reading source syntax aloud does not solve the problem for him. Instead, he speaks the intent of the work and lets the agent write the implementation. This changes the unit he needs to express, from individual code tokens to a task and its constraints.

The distinction is useful beyond his situation. A prompt can explain what needs to happen, why it matters, and what must be preserved. The agent can inspect the project to determine which files and commands are involved.

This does not make clear communication optional. A wrong machine name or ambiguous destination can still change the task. The aim is to remove unnecessary typing while retaining the details that determine the correct outcome.

## What Theo covers: make the input surface fit the person

At 6:00, Theo describes using his phone more because one-handed input is more comfortable there. The phone becomes a way to direct work, while another computer performs it. Mobile access is useful because it preserves the task without requiring the same physical interaction.

At 8:00, he discusses dictation around colleagues. His microphone demonstration addresses a social obstacle as well as a technical one: he does not want speaking to the computer to disturb everyone nearby.

The equipment and transcription app are his setup, rather than requirements for T3 Code. His observations about quiet speech and background noise apply to that demonstration. They do not establish universal performance for another microphone, room, or speech service.

The general lesson is to identify the friction before buying or configuring anything. For one user, dictation is the missing input path. For another, the larger problem is repeatedly moving between apps or reaching a difficult shortcut.

## What Theo covers: delegate the steps around implementation

At 12:00, Theo explains why terminal interaction becomes particularly unpleasant with voice input. He then describes a project that records his machines and their roles. That context lets him request work across them without reconstructing each connection manually.

At 14:00, his example is a file transfer that must wait for a download to finish. Instead of doing the first step himself and handing off the middle, he supplies the starting condition and intended destination. The agent handles the waiting and transfer as part of one task.

At 18:02, the same idea applies to an experimental T3 Code build. He requests a separately named app and separate data location so it can coexist with his normal installation. The important detail is the isolation constraint, not the historical branch used in the example.

These examples show why a complete request can save more effort than a shorter implementation prompt. Include the preparation and final verification you already know you will need. Otherwise, each omitted step becomes another interruption and another return to the keyboard.

## What Theo covers: bring agents in earlier and return later

At 20:00, Theo broadens the discussion to tedious computer interactions. These are personal examples of delegation, rather than instructions for configuring a development project. Their common theme is that repeated navigation can itself be the work an agent performs.

At 23:01, he diagrams where agents enter a task. Previously, he uses them for chunks between his own planning and testing. He starts asking them to investigate the problem sooner and verify the result more thoroughly before returning.

He also describes allowing agents to merge some changes. That is a decision within his projects and requirements. It is not automatic authorization for a reader's agents to merge every change, nor proof that another repository has the same release safety nets.

The useful question is what evidence would make the next human review productive. A working preview, relevant test result, or resolved review concern can reduce another round of back-and-forth. Broader autonomy needs a clearer completion condition, not a vaguer one.

## What Theo covers: reduce switching and context copying

At 29:01, Theo demonstrates sending a task without leaving the new-thread composer. This makes a series of separate ideas easier to capture. He can start the first task and immediately express another without navigating back through the interface.

At 32:01, he asks for summaries of pull requests that might deserve his attention. The summary explains both the change and why it is relevant to him. The in-app pull request viewer then lets him inspect the actual review without managing a collection of browser tabs.

At 34:01, he addresses context transfer. Instead of copying a long answer between conversations, he asks an agent to find relevant earlier work. That can trade some agent time for fewer manual interactions.

His closing experiment asks viewers to start with the problem before assembling every possible detail themselves. The outcome to inspect is whether the agent finds the right evidence and produces useful work. The experiment is an invitation to test a boundary, rather than an instruction to leave a vague task unchecked.

## What it means for you in T3 Code

Start with [keybindings](/learn/customize/keybindings) and [keyboard focus](/learn/customize/keyboard-focus). `Settings → Keybindings` lists the current commands and defaults. Rebind a frequent action if its default is difficult for you to use.

For new threads on web and desktop, `Cmd+Enter` on macOS or `Ctrl+Enter` elsewhere can start work in the background. The [thread guide](/learn/threads/working-with-threads) has the current behavior, including how separate worktrees are created. In an existing conversation, modifier shortcuts can instead affect Queue or Steer, so check the context before relying on a remembered key.

Use [messages and context](/learn/threads/messages-and-context) for current input behavior and [mobile access](/learn/remote/mobile-apps) when a phone is the more useful control surface. The video's desktop dictation setup is external to T3 Code. The feature pages have the current behavior for built-in mobile input.

Use [source control](/learn/workspace/source-control) to inspect the actual pull request behind a summary. Use thread references or [portable handoffs](/learn/threads/portable-handoffs) when another conversation or provider needs context. These supported paths replace some of the manual copying shown in the recording.

## Next steps

Read [I'm done with terminals](/learn/videos/done-with-terminals) for Theo's interface argument and [If you have a Claude sub](/learn/videos/if-you-have-a-claude-sub) for his longer workflow discussion. Browse the [video collection](/learn/videos) for related examples.
