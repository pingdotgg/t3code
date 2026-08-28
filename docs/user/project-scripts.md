# Project scripts

Project scripts are shell commands you attach to a project. You can run them from the scripts menu, and one of them can prepare a new thread worktree automatically.

## Worktree setup

Mark a script to run when a thread worktree is created. T3 Code starts that command as its own process in the new worktree (not by typing into a terminal), waits for it to finish, then starts the first agent turn.

If setup fails, the thread shows an error and a **Rerun setup** action. The first turn still proceeds after a failed setup so you can inspect or recover; rerun setup before sending more work if the worktree is incomplete.

You can opt out of waiting so the first turn starts immediately while setup continues. In `t3.json`, set `awaitSetupScript` to `false` on that script. A timeout (ten minutes by default, or `setupScriptTimeoutMs`) fails the setup run loudly instead of hanging forever.

Setup is also idempotent: if the same worktree is asked to run setup twice at once, the second request joins the run already in progress.
