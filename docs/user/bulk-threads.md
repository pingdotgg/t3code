# Bulk Threads

Bulk threads run the same prompt several times at once — one thread per value you give it. It is
built for repeating a command across a list: the same review across five tickets, the same fix
across three services.

## Starting a batch

Open the command palette and pick **Bulk new threads in \<project\>**, or turn on **Bulk** in the
context strip above the message composer. Either way you land in a normal draft: write the prompt,
pick the model, the permission mode and the base branch exactly as you would for a single thread.

Mark the part that changes per thread with a placeholder in braces:

```
/rooom:ship {jirakey}
```

The name may hold letters, digits, `_` and `-`. The **Bulk** toggle shows how many placeholders
were recognised, so you can see the prompt is understood before you send.

A prompt that contains code needs care: `import { useState } from "react"` reads as a placeholder
named `useState`. Write your placeholder with double braces — `{{jirakey}}` — and the whole prompt
switches to that spelling, leaving every single-braced piece of code literal.

Send the draft. Instead of starting one thread, T3 Code asks what the placeholder stands for.
Enter the values separated by commas or newlines:

```
FE-101, FE-102, FE-103
```

Confirm, and one thread starts per value. Repeating the same placeholder in the prompt fills it
with the same value. A prompt can use several placeholders; give each one either a full list of
the same length, or a single value that applies to every thread. A batch starts at most 20
threads.

## What every thread shares

Model, reasoning effort, permission mode, project and base branch are taken once from the draft
and applied to every thread. Only the prompt differs.

Each thread gets its own git worktree, so the agents cannot overwrite each other's files. The
worktrees are created from the base branch you picked in the draft, and each thread runs the
project's setup script in its own tree. In a project without git the threads share the checkout
instead — the confirmation dialog says so before anything starts.

Bulk sends carry text only. Remove images, terminal context and review comments from the composer,
or turn bulk off to send them as a single thread.

## While the batch starts

Threads start one after another, not all at once, so the worktrees and setup scripts do not pile
up. They appear in the sidebar as they come up, and each one runs independently from there.

**Stop starting** halts the batch: threads that already started keep running, the rest are never
created. If a single thread fails to start, the batch continues without it and the summary names
the values that did not make it.

## Leaving bulk mode

Turn **Bulk** off in the context strip, or start a plain new thread — that always returns the
draft to normal.
