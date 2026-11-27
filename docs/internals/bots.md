# Bots

A Bot is a coordinator thread: it delegates work to worker threads, keeps memory, and is woken when
its workers or what it watches reaches a milestone. User guide: [Bots](../user/bots.md).

There is deliberately no built-in, environment-wide Bot. A Bot whose instructions make it a chief of
staff does that job without a guarded folder, a settings-owned grant or a lifecycle of its own.

## One primitive

- A thread is a Bot when it was created with `botConfig` (`thread.create`). Nothing turns an
  existing thread into one or back: **Start a Bot from this thread**
  ([`BotService.start`](../../apps/server/src/bots/BotService.ts)) launches a new Bot seeded with a
  `full_thread_summary` handoff of the source and groups the source (and any workers it led) under it;
  `BotService.create` starts one from a name and instructions, which seed `preferences.md`. The way
  out is archiving or settling the Bot: clients then list its workers at the top level again
  (`groupThreads`), and the server stops waking it. Reopening it takes the workers back.
- Every Bot runs in the "No project" scratch project. Its instructions forbid touching files, so its
  folder holds nothing; a project would only tie it to one repo and hide that its workers go anywhere.
- Workers are `groupedUnderThreadId`, one level deep. Threads a thread launches join its group, so a
  Bot's launches become its workers, in whatever project each one names.
- Memory is `<base>/bots/thread-<id>/`: `preferences.md` (the user's instructions) and one file per
  note in `notes/<slug>.md`, whose header holds its title and one-line summary. The index the Bot
  reads is built from those headers on every read, so hand edits cannot leave it stale. Bots reach
  memory only through the `t3_bot_*` tools: their instructions forbid file tools, and provider
  sandboxes treat paths outside the workspace differently. These files are user-owned; the server
  only moves an old single `notes.md` to `notes/notes.md`, once.
- Explicit watches (threads that are not its workers, workflow runs) live in `<base>/bots/watches.json`,
  read once and matched in memory against every milestone.

## Instructions

Bot instructions ride on every Bot turn's prompt
([`botInstructions.ts`](../../apps/server/src/bots/botInstructions.ts)), not in a file. Claude reads
`CLAUDE.md` and Codex `AGENTS.md`, so a file could not reach every provider; a seeded file also went stale for existing Bots. The text tells a Bot to
delegate and never run shell commands, read code or edit files; `evals/mcp-tool-use` holds the
case for it.

## Who may act as a Bot

- MCP scopes carry `bot`, fixed when the thread's credential is issued, since a thread never changes
  role. It decides discovery: Bot tools and `t3_workflow` are listed only to Bots (`t3_workflow`
  only while Labs → Workflows is on), so ordinary threads pay no context for them. Every Bot tool
  call still checks `BotService.isBot`. MCP events stay hidden from every thread, Bots included:
  Bots hear milestones in-process through their wakes.

## Wakes

[`BotWakeReactor`](../../apps/server/src/bots/BotWakeReactor.ts) feeds `MilestoneHub` events to
`BotService.handleMilestone`, which wakes a worker thread's leader and every Bot watching the target
with a queued message. Its command id derives from the milestone and Bot, so a repeat replays the
first send. A workflow run a Bot starts with `t3_workflow` is watched for it. A run watch also
matches its agent-step threads' milestones (they carry `workflowRunId`) except their turns ending,
which `workflow.run_ended` reports for the run. A thread watch ends when the thread's turn settles
and a run watch when the run ends; workers are never unwatched. Milestones are local, so wakes cover
this environment's threads and runs only.
