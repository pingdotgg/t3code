---
name: playwright-cli
description: Automate browser checks and interactions with the installed playwright-cli,
  or work on Playwright tests.
allowed-tools: Bash(playwright-cli:*) Bash(npx:*) Bash(npm:*)
---

# Playwright CLI

For browser work, prefer T3 collaborative preview tools when exposed, following their ownership and retry rules, or the provider's native browser or computer-use interface for an explicitly requested open browser. Use this CLI for an explicit CLI or repository workflow, or when no preferred interface is available. Honor the user's explicit tool choice.

Use the installed CLI when appropriate to the task. Read `playwright-cli --help` and [commands.md](references/commands.md) for command usage. Open or select the intended browser/session, take a fresh snapshot, and use its current element references. Refresh references after navigation or substantial DOM changes.

Verify actual user-visible behavior, relevant console/network failures, and screenshots when layout matters. Do not treat a successful click as proof the workflow completed. Preserve unrelated user sessions and close only task-owned resources when appropriate.

Load focused references for [tests](references/playwright-tests.md), [request mocking](references/request-mocking.md), [running code](references/running-code.md), [sessions](references/session-management.md), [storage](references/storage-state.md), [test generation](references/test-generation.md), [tracing](references/tracing.md), [video](references/video-recording.md), or [element attributes](references/element-attributes.md).

Browser automation carries the same task authorization as other tools. Inspecting a form does not authorize submitting external actions. Keep saved auth/storage artifacts private.
