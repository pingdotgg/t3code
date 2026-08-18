# Handing off a thread

Long sessions fill their context window before the work is done. A **handoff** moves the remaining work into a fresh thread without you writing the recap.

## Asking for one

Tell the agent, in whatever words you like: "hand this off to a fresh thread". The agent can also offer one when it notices it is running low on context.

You can scope it: "hand off just the remaining test failures". The successor is then aimed at that, not at a rehash of everything.

## What happens

The agent writes the new thread's name and a summary of the work so far — it is the thing that actually holds the context, so the recap is grounded rather than reconstructed. T3 Code then creates a thread in the same project, seeds it with that summary as its first user message, and starts it immediately. No review step.

The summary is written to be useful rather than complete: it references files, commits, and docs by path or hash instead of pasting them, states what was already tried and ruled out, describes the current state, and lists the concrete next steps. Secrets and tokens are kept out of it by instruction.

You get a confirmation in the parent thread with the child's title and a link to it. If the handoff fails, the agent reports the error there instead — a failed handoff never looks like a successful one.

## What the new thread inherits

Model, permission mode, and interaction mode carry over from the parent, so "continue this work, fresh" preserves how you were working. Branch, worktree, and environment mode never carry implicitly.

Its title is the name the agent chose, and auto-titling will not overwrite it.

The child is a first-class thread — sidebar, inbox status, and notifications behave exactly as they would for a thread you typed yourself, including a completion notification when its seed turn finishes.

## The parent

Left completely alone. Not settled, not snoozed, no extra turn injected. Handoff never surprises you with inbox changes.

Both threads record the lineage, so the work log on each links to the other.

## Limits in this version

Handoff works from a live Claude session only. Threads running other providers, and threads with no live agent, cannot hand off — with nothing holding the context, there is nothing to summarize. The child always lands in the parent's project.
