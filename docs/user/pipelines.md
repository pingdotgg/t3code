# Pipelines

A pipeline is a saved sequence of agent steps. Each step runs in its own thread, and its final
answer is passed to the next step. Use one when you repeat the same hand-offs, such as refine a
request, implement it, then test and review the result.

Pipelines need a T3 Code server that supports them. Update an older server before using them.

## Set up a pipeline

Define pipelines in **Settings → Pipelines** on web, desktop, and mobile. Choose **New pipeline**
and start from **Blank** or from the **Feature delivery** template.

T3 Code adds **Feature delivery** once: Refine requirements, Implement, Prepare QA, QA, Review,
and Visual review guide, using Claude models. If you delete it, create it again from the template.

Each step has:

- A name, and the provider and model it uses, with options such as effort.
- Permissions, which set the step's [permission mode](./permission-modes.md). Pipelines have no
  plan mode.
- Skills, which T3 Code adds to the prompt as `$skill` mentions.
- A prompt template.
- **Pause before this step**, which waits for you before the step starts.

### Template variables

Use these variables in a prompt template:

| Variable                             | Value                                                        |
| ------------------------------------ | ------------------------------------------------------------ |
| `{{input}}`                          | The prompt you started the run with.                         |
| `{{previous.output}}`                | The final answer of the nearest earlier step that completed. |
| `{{steps.<step id or name>.output}}` | The final answer of that step.                               |

Because `{{previous.output}}` comes from the nearest completed step, it is not always the step directly above, for example after you skip one.

### Skills

Skills are added to the prompt as text, so how well they work depends on the provider. Claude
expands only the last skill mention in a prompt, so give a Claude step one skill. A provider
without skill support can show the mention to the agent as literal text.

## Start a pipeline

Start from a new thread:

- On web and desktop, pick the pipeline from the **Pipeline** control in the composer.
- On mobile, pick it on the new-task screen.
- In the command palette, choose **Start pipeline…**.

The starting prompt is text only. Attachments are not supported.

A run creates a parent thread that shows progress, and one thread per step. The step threads sit
under the parent in the sidebar. The parent has no composer.

## Work with a run

A step is done when its agent has finished, including any subagents it launched and any queued
follow-ups. Its final answer feeds the next step.

Open a step's thread to steer it like any other chat. When the run is paused, either before a step
or after a failure, you can keep chatting in the previous step's thread to refine its answer.
**Continue** then uses that thread's latest answer.

The run offers these actions:

- **Continue** resumes a paused run.
- **Retry step** runs the step again in a new thread, in the same workspace.
- **Skip step** moves on without it.
- **Cancel** stops the active step.
- Each step has a pause toggle, so you can pause before a step that has not started yet.

### Shared workspace

Every step works in the first step's workspace, including its worktree and branch. If you chat in
an earlier step while a later one is running, two agents edit the same files. Wait for the later
step to finish before steering an earlier one.
