# Bots

A Bot is a conversation that coordinates instead of coding. It hands work to worker threads,
follows them, and keeps notes. A Bot belongs to no project: it sends each worker to the project the
work is in, and can reach your linked environments. Bots show at the top of the sidebar; their
workers stay out of the thread list.

## Starting a Bot

- **From scratch:** open the command palette and choose **New Bot**. Give it a name and instructions
  that describe its job, such as "Chief of staff: keep track of everything I have going on across my
  projects and tell me what needs me." You can edit the instructions later on the Bot's page.
- **From a thread:** in a thread's menu or the command palette, choose **Start a Bot from this
  thread**. The new Bot starts with a summary of the thread, and that thread becomes its first
  worker.

## Working with a Bot

- When a worker finishes or needs your approval, the Bot is told and can follow up. Ask it to watch
  other threads or workflow runs too.
- The panel beside a Bot's conversation holds its instructions and notes, which you can edit, and
  can mute worker notifications other than requests for input. Its workers are listed there too.
- Settle or archive a Bot when you are done: its workers go back to the thread list and it stops
  being woken. Reopen it to take them back.
