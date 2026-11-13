# Pipelines

A pipeline is a saved sequence of agent steps. Each step runs in its own thread, and the result it
hands off is passed to the next step. Use one when you repeat the same hand-offs, such as refine a
request, implement it, then test and review the result.

Pipelines need a T3 Code server that supports them. Update an older server before using them.

## Set up a pipeline

Define pipelines in **Settings → Pipelines**. Choose **New pipeline** and start from **Blank** or
from a template:

- **Feature delivery**: a full feature-delivery flow from requirements to merge and follow-through.
  Its last step waits until you start it, then merges the pull request and does the post-merge
  work.
- **PR visual review**: for reviewing someone else's work. Start it with a pull request link or
  number. It reads the change, captures before and after screenshots, and builds a visual review
  guide that ends with questions and concerns you can turn into review comments. It never comments
  on, approves, changes or merges the pull request. Because it checks out the pull request's head
  commit, start it in a new worktree so your own branch isn't switched.

T3 Code adds each template once. If you delete one, it stays deleted, and you can recreate it from
the template. While you have not edited a pipeline made from a template, it is updated to the
latest template when T3 Code updates. Once you edit it, or an agent edits it for you, it is yours
and stays as you left it.

Each step has a name, a provider and model, a prompt template, optional skills, and a
[permission mode](./permission-modes.md). Pipelines have no plan mode. The templates' steps use the
default runtime mode from your settings. You can also make a step wait for you before it starts.

You can also ask an agent to create or edit a pipeline for you. New steps use the agent's model
unless you name another. An agent can't save a pipeline that has any step in a broader permission
mode than its own, and it can't change pipelines while its thread is in plan mode.

Each step can compact its thread once the next step has started (**Compact after handoff**). It is
on by default, except for the last step, which compacts when the run completes if you switch it
on. Compacting while the provider's prompt cache is still warm makes coming back to a finished step
much cheaper, whether to give it feedback or to chat in its thread. Steps with under 50,000 tokens
of context, or on providers that cannot compact, are left alone. A compacted step keeps working
from its summary, and the compaction appears in its thread like automatic compaction.

### Template variables

Use these variables in a prompt template:

| Variable                             | Value                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `{{input}}`                          | The prompt you started the run with, plus its attachments and added context. |
| `{{previous.output}}`                | The output of the nearest earlier step that completed.                       |
| `{{steps.<step id or name>.output}}` | The output of that step.                                                     |

`{{previous.output}}` is not always the step directly above, for example after you skip one.

### Skills

Skills are added to the prompt as text, so how well they work depends on the provider. Claude
expands only the last skill mention in a prompt, so give a Claude step one skill. A provider
without skill support can show the mention to the agent as literal text.

## Start a pipeline

Pick a pipeline when you start a new thread, or choose **Start pipeline…** in the command palette.
You can also ask an agent to start one for you. When you ask them to, agents can list, show, add,
change, and delete your pipelines, and start, check on, continue, and cancel runs.

The starting prompt takes what a chat message takes: images, files and added context (terminal output, review comments, preview annotations, threads, environments). They go with the prompt to every step whose template uses `{{input}}`, each time that step starts, including retries, reruns and feedback. Steps that do not use `{{input}}` get none.

Servers on older versions of T3 Code take text only for pipelines.

## Work with a run

A step is done when its agent hands off its result and has finished, including any subagents it
launched and any queued follow-ups. An agent can't hand off while its subagents or background
commands still run, so a step whose agent leaves a dev server running cannot finish. T3 Code adds
a short instruction to every step's prompt: hand off with the `handoff_pipeline_step` tool when
the work is done, and ask you when something it builds on is missing, such as an earlier step's
work or the branch it stacks on. Open a step's thread to steer it like any other chat.

If you ask a step for something outside its role, for example to change code in a review step, or
to fix what an earlier step got wrong, it does not do it itself: the work would skip the steps
after it. It asks whether to pass the request to the run's coordinator. Say yes and the step ends
its turn with **No handoff**, and the coordinator opens beside the step (a sheet on mobile) to
route the request. Say no, or tell it to do the work anyway, and it does what you say.

If a step's agent ends its turn without handing off, for example with a question, the run pauses
and the step shows **No handoff**. Answer in the step's thread; when the agent then hands off, the
run continues on its own. **Continue with last message** moves on with the thread's latest answer
instead.

A step that waits on checks, reviews or a merge watches its pull request and ends its turn; the run
then shows **Waiting on pull request** instead of **No handoff**. The watch ends when the step
hands off or stops being the run's current step, and when the pull request merges; the merge wakes the
step, so a repository that merges through a queue needs no one to confirm it.

If a step's turn fails or you stop it, the run pauses and the step shows **Failed** or **Stopped**.
Fix the cause and ask the agent to go on in the step's thread; when it hands off, the run continues
on its own, as after **No handoff**. A step that hits a usage limit does not pause the run while
T3 Code will resume its thread at the reset, for example with **Resume after usage limits** enabled
in **Settings → Threads**; the run picks up the resumed turn's result.

- **Refine before continuing.** When a run is paused, before a step or after a failure, keep
  chatting in the previous step's thread. **Continue** then passes that thread's latest answer on.
  A paused run is marked as needing attention in the sidebar, unless its step is waiting on a
  pull request. Tap the attention badge on a run to open the step that needs you. After a retry
  or a rerun, the run lists each step once; earlier attempts are folded under it.
- **Retry** runs a failed step again in a new thread, in the same workspace. When the run uses a
  T3 Code worktree, you can choose **Retry from step start**: it first puts the files back to how
  they were when the step began, then runs the step again. **Retry with current files** keeps
  whatever the failed attempt left behind. Commits the step made stay on the branch either way.
  In a project with several tracked repos, the run's worktree is a task folder with one worktree per
  repo. Its starting files are not saved, so only **Retry with current files** is offered: restoring
  one repo and not the others would leave the folder inconsistent.
- **Skip** moves on without a step.
- **Rerun from here** on an earlier step of a paused, cancelled or completed run starts that step
  and every step after it again. The steps before it keep their results.
- **Cancel** stops the active step.
- **Pause** a step that has not started yet if you want to check the result before it runs.

Agents cannot move past a pause on a run you started, with one exception: the run's coordinator
(below) can continue it when you ask it to in its chat.

### Give feedback to an earlier step

When you notice an earlier step got something wrong, send it feedback instead of starting over.
Use **Send feedback…** on a step in the run page, or **Send feedback** on an assistant message
(or on selected text) in any step's thread. The step receives your feedback in its own thread,
fixes its work and hands off again. Every later step then gets a message in its own thread saying
what changed, and redoes its work against the new result, including the feedback given earlier in
the run. A later step that is running is stopped first. Steps that never ran, or whose thread was
archived or deleted, start fresh instead. Pauses before later steps still apply. If a step fails
while redoing its work, **Retry** keeps the feedback.

This differs from **Rerun from here**, which starts the step and everything after it again in new
threads with the original prompts. Use rerun for a clean start, and feedback to correct what is
there. Feedback is text only. To talk to the step that is running right now, just write in its
thread.

### Coordinator

A run's page is a chat with its coordinator, an agent that knows the run and can check on it,
send feedback to steps, continue past a pause when you ask it to, rerun or cancel. It acts when
you message it, or when a step passes a request on (below), and it does not edit files itself.
Change its model in the composer like in any thread. The step list stays pinned above the chat,
where each step's feedback is listed.

From a step's thread, click **Coordinator** in the header (or run **Open pipeline coordinator**
from the command palette) to chat with it beside the step. When a step passes your request to the
coordinator, it opens by itself while you are looking at that step. The step's message starts with
"From step <name>". The coordinator sends the request as feedback to the step that owns it, so
every later step, including the one that passed it on, redoes its work. When that is unclear it
asks you, and when the step should do the work after all it sends it back there. On a message,
**Send feedback** lets the coordinator decide where it goes, or sends it straight to one step. On
mobile, tap **Coordinator** on the bar above a step's composer to chat in a sheet, and the speech
bubble below an assistant message to send feedback.

### Shared workspace

Every step works in the first step's workspace, including its worktree and branch. In a project with
several tracked repos, that is one task folder shared by all steps. If you chat in
an earlier step while a later one is running, two agents edit the same files. Wait for the later
step to finish before steering an earlier one. Sending feedback stops the running step first, which
can leave its files half changed for the step you sent the feedback to.
