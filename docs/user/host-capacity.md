# Host capacity

Many parallel chats, scheduled runs, delegated tasks and pipeline steps can overload one machine. Host capacity lets an environment decide when a new turn may start. It never pauses or stops a turn that is already running.

## Turn it on

Choose **Settings → Threads → Host capacity**. The settings belong to one environment, so a remote host enforces its own; the section appears when a single environment is selected and its server supports it. Both are off by default.

- **Pace new turns by host load** holds new turns while the host's memory is critically low. While memory is elevated or the CPU is busy, it starts one new turn every 30 seconds.
- **Limit running turns** sets a hard limit, from 1 to 64. A new turn waits while that many turns are running.

The section shows how many turns are running and how many are waiting. On mobile, the same controls are on the server's Threads settings page.

## What waiting looks like

A turn that waits shows as **Queued** in the thread list, with a static indicator. Its queue item says why: waiting for a free slot (n/N running), or waiting for the host. On the web and desktop it sits above the composer; on mobile, open the queue from the thread. Waiting turns start on their own, oldest first, when a slot frees, memory recovers or the pacing gap passes.

- **Start now** starts the turn anyway, ignoring the limit. Only you can do this. Agents cannot skip the limit.
- **Remove** cancels the waiting turn.

While any turn waits, a pill in the sidebar (and a card on the mobile Home screen) lists the waiting threads.

## What counts

Only turns that are preparing, starting or running count. A new thread or pipeline step counts while its workspace is prepared and is checked against the limit just before it starts, so the count can briefly exceed the limit while several workspaces are prepared at once. A turn that waits for your answer or approval is still running and holds its slot. A turn that is blocked waiting for another thread or a delegated task does not count, so a parent waiting on a queued child cannot deadlock. When the wait returns, the turn counts again, even if that briefly puts the count above the limit. New turns then wait until it drops below.

Steering a running turn, interrupting, and stopping are never held back. Neither are one-shot jobs such as thread titles and commit messages.

Running turns are never paused. To stop one that is overloading the host, interrupt it.
