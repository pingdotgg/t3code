# Cursor Cloud agents

A Cursor thread can run on your machine through the Cursor CLI, or as a Cursor
Cloud agent on a Cursor-hosted machine that works from your GitHub repository.
Hand off work that should keep going while your computer sleeps or T3 Code
restarts, and follow it in the same thread.

## Set up

1. Create an API key in the Cursor dashboard under **API Keys**.
2. In **Settings > Providers**, enable **Cursor** and add a `CURSOR_API_KEY`
   environment variable with that key. Keep it marked sensitive. Cloud agents do
   not need the Cursor CLI to be installed.
3. Give Cursor access to the repository through its GitHub app.

The Cursor CLI also signs in with `CURSOR_API_KEY` when it is set.

## Start a cloud thread

With Cursor selected in a new thread, choose **Cloud** instead of **Local** at the
start of the bar below the composer. If Cloud is not set up yet, **Set up Cloud**
opens the provider settings. The choice is fixed once you send the first message.

The branch picker chooses the pushed branch the agent starts from; it never
changes your checkout. The project must be a git checkout with a GitHub remote,
and the branch must already be on GitHub. Local changes that are not pushed are not
included, and T3 Code warns when you have some.

The agent pushes its work to a new `cursor/…` branch. With **Cloud pull requests**
on, Cursor opens a pull request and T3 Code links it to the thread.

## Working with a cloud agent

- Send one message at a time. Wait for the run to finish, or stop it, before
  following up. Stopping cancels the run in Cursor.
- The model picker lists Cursor's cloud models. To change the model, start a new
  thread. **Default** uses your Cursor default model.
- Cloud agents do not ask for approval. They run with full access inside their
  machine, whatever permission mode the thread uses.
- Attach up to five images. Other files stay on your machine, so paste their
  contents instead.
- Checkpoints, revert, and compaction are not available. The terminal, diffs, and
  git actions show your local checkout, not the agent's. Review the agent's work in
  its branch or pull request.

## Lost connections and restarts

T3 Code reconnects to a running agent after a dropped connection without losing
output. When the T3 Code server restarts during a run, it reattaches on startup
and shows the run's final reply; activity from while it was down is not replayed.
