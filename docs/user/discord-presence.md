# Discord Rich Presence

Discord Rich Presence shows what you are working on in your Discord profile, next to your name. T3
Code publishes a short summary — the active project and how many agents are running or waiting on
you — through the Discord desktop app on the same machine.

It is off by default, desktop-only, and has nothing to do with connecting T3 Code to Discord beyond
that summary.

## Turning it on

1. Turn on **Activity Privacy** > **Display current activity as a status message** in Discord.
2. In T3 Code, open **Settings** > **Browser** > **Discord** and enable **Discord Rich Presence**.
3. Tick the details you want to show: **Project name**, **Model**, **Agent activity**, and
   **Elapsed time**. Anything left unticked is never sent.

Discord must be running for the status to appear. If T3 Code cannot reach it, the setting shows a
warning and connects on the next activity change once Discord is open.

## If it does not connect

The setting tells you what is wrong:

- **Can't reach Discord** — the Discord desktop client is not running. Open it; T3 Code reconnects.
- **This build isn't set up for Discord** — the app was built without a Discord application, so the
  feature is unavailable.
- **Connected to Discord** — the status is being published.

## What it shares

Only the details you tick are published. Project and model details appear when a thread is open:

- **Project name** — the first line, for example `In my-app`. Unticked, this line is hidden.
- **Model** — the model the thread you are viewing is using, for example `Claude Sonnet 4.5`.
- **Agent activity** — for example `Running 2 agents`, `Waiting for you`, or `Idle`.
- **Elapsed time** — how long this session has been running.

Model and agent activity share the second line, joined by a dot. Thread titles, prompts, messages,
file paths, and terminal output are never sent. Hovering the T3 Code image shows the build channel
and version. Presence is visible to your Discord friends, so leave a detail off if you would rather
not share it.

## Notes

- The status clears when you turn the setting off, when you quit T3 Code, or when the connection to
  Discord drops.
- Project and model details follow the thread you are viewing. Agent activity counts threads across
  your connected environments, including remote servers.
- Some builds are not configured for Discord; there the setting has no effect.
