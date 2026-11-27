# Continue on another machine

You started a thread on your PC, and now you sit at your Mac. **Continue on another machine** sends the thread to the Mac. The agent there gets the conversation and the branch, and it keeps working.

## Before you start

- **Linked environments**: Turn on **Settings → Labs → Linked environments** on both machines.
- **A Full access link**: Link this machine to the other machine with **Full access** ([Link another environment](./remote-access.md#link-another-environment)). To send threads back, the other machine needs its own link. Tick **Also link … back** when you link.
- **A project with a Git remote**: The action is not shown for threads without a project or without a Git remote.

## Send a thread

1. Open the thread **...** menu in the thread header, and select **Continue on another machine**. The command palette and the right-click menu of a thread in the sidebar also have this action.
2. Pick the machine. You can pick only reachable machines with a Full access link. The other machines show why you cannot pick them.
3. If the dialog shows uncommitted changes or unpushed commits, tick **Commit and push my changes first**.
4. Optional: write a message for the agent on the other machine.
5. Confirm the dialog.

The action is disabled while the agent works. Wait for the turn to end, or stop it.

If you wrote a message, the agent on the other machine starts work immediately. If you did not, the new thread waits for you.

## What moves

These items move to the other machine:

- **The branch**: Only pushed commits move.
- **The conversation**: Your messages and the agent replies. Long threads send the first request plus the newest messages, up to 200.

Tool activity, reasoning, attachments, checkpoints, and uncommitted files stay on this machine. The agent on the other machine gets the history as a [portable handoff](./portable-handoffs.md).

## On the other machine

- **New project if necessary**: If the project is not on that machine, T3 Code clones the repository into its projects folder and adds the project.
- **Same branch**: The new thread gets a new worktree on the same branch. Pushes go to the same branch and the same pull request.
- **Branch already on that machine**: This happens when you send a thread back to a machine that had it before. T3 Code makes that branch match the pushed branch, so you can send the thread again later. The result depends on local work, that is, uncommitted changes or unpushed commits on that branch:
  - **Checked out, no local work**: The project folder or a worktree has the branch checked out. T3 Code moves that checkout forward to the pushed commits, and the new thread starts there.
  - **Not checked out, no local work**: T3 Code replaces the branch with the pushed branch and makes a new worktree.
  - **Local work**: T3 Code stops the send, shows a message, and creates nothing. On that machine, commit and push the work, or discard it. Then send the thread again.

## On this machine

The thread shows **Moved to** and the name of the other machine, with a link to the new thread.

- **Keep working here**: Click it to remove the note.
- **Send a message**: A new message in this thread also removes the note.

Do not push from both machines at the same time. The two threads use the same branch.

## From your phone

Open the thread menu and tap **Continue on another machine**. The same dialog opens.

## Ask an agent

Tell the agent in the thread "continue this on my Mac". The agent sends the thread for you. [Outside agents](./outside-agents.md) can do the same with `t3_thread_transfer` and the action `continue_on`.

Done: the thread now runs on the other machine, with its branch and its history.
