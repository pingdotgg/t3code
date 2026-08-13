# Parallel agents

Run independent sub-tasks side by side instead of waiting for one agent to finish each step.
Type `/parallel` followed by a prompt in a thread's composer and send it. Instead of running in
the current thread, the prompt starts a new linked thread that works on the sub-task at the same
time. Repeat with another prompt to run more agents at once, and switch the model between sends to
mix providers — each parallel agent uses whatever model the composer had selected when you sent it.

The originating thread stays in charge of the story. It records an activity when each parallel
agent starts, and another when the agent finishes, including the agent's final response, so results
land back in the shared conversation. Open the linked thread from the sidebar at any time to read
the full run, follow up with more messages, or archive it like any other thread.

In a Git project, each parallel agent gets its own worktree branched from the thread's current
branch, so simultaneous edits never fight over one checkout. Projects without Git share the
thread's workspace, which is fine for read-only research tasks but can conflict when two agents
edit the same files.

A few limits to know about:

- `/parallel` is text-only. Attached images, terminal contexts, and review comments stay in the
  composer so nothing is silently dropped.
- `/parallel` needs an existing thread to report back to. In a brand-new draft, send a first
  message before spawning agents.
- Each running agent is a separate provider session, billed like any other thread.
