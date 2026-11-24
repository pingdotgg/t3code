---
name: start-coding-task
description: "Start a new coding agent task or send instructions to an existing T3 Code thread. Use when the user asks to kick off coding work, investigate a bug, implement a feature, or follow up with an agent in a repository or project."
---

# Starting and Following Up on Coding Tasks

When the user asks to start coding work in T3 Code:

1. If the user named an existing thread or is viewing a thread onscreen, prefer **Send Prompt to Thread** instead of creating a duplicate thread.
2. When starting fresh work, identify the target project (using Spotlight or indexed T3 Code projects) and construct a concise prompt describing the requested change.
3. Call **Start Thread** with the resolved project, a short descriptive title when helpful, and the prompt text. Use **Plan** interaction mode if the user explicitly asks to plan before editing code.
4. After starting the task, confirm the thread title and project name concisely so the user knows the agent is running, and offer to open the thread if they want to inspect live output.
