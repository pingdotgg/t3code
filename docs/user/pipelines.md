# Pipelines

A pipeline is a saved sequence of agent steps. Each step runs in its own thread, and its final
answer is passed to the next step. Use one when you repeat the same hand-offs, such as refine a
request, implement it, then test and review the result.

Pipelines need a T3 Code server that supports them. Update an older server before using them.

## Set up a pipeline

Define pipelines in **Settings → Pipelines**. Choose **New pipeline** and start from **Blank** or
from the **Feature delivery** template, a full feature-delivery flow from requirements to review.
T3 Code adds it once. If you delete it, it stays deleted, and you can recreate it from the
template.

Each step has a name, a provider and model, a prompt template, optional skills, and a
[permission mode](./permission-modes.md). Pipelines have no plan mode. The starter's steps use the
default runtime mode from your settings. You can also make a step wait for you before it starts.

### Template variables

Use these variables in a prompt template:

| Variable                             | Value                                                        |
| ------------------------------------ | ------------------------------------------------------------ |
| `{{input}}`                          | The prompt you started the run with.                         |
| `{{previous.output}}`                | The final answer of the nearest earlier step that completed. |
| `{{steps.<step id or name>.output}}` | The final answer of that step.                               |

`{{previous.output}}` is not always the step directly above, for example after you skip one.

### Skills

Skills are added to the prompt as text, so how well they work depends on the provider. Claude
expands only the last skill mention in a prompt, so give a Claude step one skill. A provider
without skill support can show the mention to the agent as literal text.

## Start a pipeline

Pick a pipeline when you start a new thread, or choose **Start pipeline…** in the command palette.
You can also ask an agent to start one for you. Agents can list your pipelines, start, check on,
continue, and cancel runs when you ask them to.

The starting prompt is text only. Attachments are not supported.

## Work with a run

A step is done when its agent has finished, including any subagents it launched and any queued
follow-ups. Open a step's thread to steer it like any other chat.

- **Refine before continuing.** When a run is paused, before a step or after a failure, keep
  chatting in the previous step's thread. **Continue** then passes that thread's latest answer on.
  A paused run is marked as needing attention in the sidebar.
- **Retry** runs a failed step again in a new thread, in the same workspace. When the run uses a
  T3 Code worktree, you can choose **Retry from step start**: it first puts the files back to how
  they were when the step began, then runs the step again. **Retry with current files** keeps
  whatever the failed attempt left behind. Commits the step made stay on the branch either way.
- **Skip** moves on without a step.
- **Cancel** stops the active step.
- **Pause** a step that has not started yet if you want to check the result before it runs.

An agent cannot move past a pause on a run you started. Continue those yourself.

### Shared workspace

Every step works in the first step's workspace, including its worktree and branch. If you chat in
an earlier step while a later one is running, two agents edit the same files. Wait for the later
step to finish before steering an earlier one.
