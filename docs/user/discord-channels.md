# Discord channels

Connect a Discord bot in **Settings → Channels** to start T3 Code tasks from a bot mention or the `/t3` command. Each request creates a T3 Code thread, and progress and completion are posted back to the Discord thread.

Choose where channel tasks run:

- **Isolated worktree** creates a dedicated branch and worktree for every request. If T3 Code cannot create them, the task does not start.
- **Project checkout** runs directly in the selected project's existing checkout. The agent can modify its currently checked-out branch, including `main`, and simultaneous tasks can affect the same files.

Isolated worktrees are the default. Use the project checkout option when direct changes are intentional and you control who can send requests to the bot.
