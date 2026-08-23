# Starting threads from the CLI

`t3 thread new` starts a new thread — including its first turn — on a running T3 Code server,
without opening the web or desktop app. Use it to kick off work from scripts, cron jobs, or
another terminal.

```bash
npx t3 thread new "Fix the flaky login test"
```

The command finds the running server the same way `t3 pair` does (the shared `~/.t3` install, or
the current worktree's dev server when run inside one), authenticates through the server's local
credential store, creates the thread, and sends the prompt as its first message. It prints the
thread id and the server origin; follow the thread from any connected client.

A live server is required: the thread's first turn executes inside the server process. If none is
running, the command fails and points you at `npx t3 serve`.

## Choosing the project

Without flags the thread lands in the project whose workspace root matches the current working
directory. Pick another project by id or workspace root:

```bash
npx t3 thread new "Update the changelog" --project C:\repos\my-app
```

## Options

- `--project <id-or-path>` — project id or workspace root. Defaults to the current directory's
  project.
- `--title <title>` — fixed thread title. Without it the server generates a title from the first
  turn.
- `--runtime-mode <mode>` — permission mode: `approval-required`, `auto-accept-edits`, `auto`, or
  `full-access` (default). A thread started with `approval-required` waits for approvals in a
  connected client.
- `--base-dir <dir>` — explicit T3 Code data directory, as for the other `t3` subcommands.

The thread uses the project's default model selection.

## Limits

The thread runs in the project checkout on the current branch. Starting the thread in a dedicated
git worktree, running the project setup script, and attaching images are only available when
starting threads from the app. For running one prompt across many values, see
[Bulk threads](./bulk-threads.md).
