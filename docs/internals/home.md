# Home

Home is one agent thread per environment that coordinates work across its projects and linked
environments. User guide: [Home](../user/home.md).

## Who may act as Home

- Any T3 server can run Home; nothing ties it to the desktop app. Its state is
  `ServerSettings.home`, so every client gets it with the settings stream. Clients cannot patch it:
  `ClientServerSettingsPatch` omits `home`, and only the `home.*` RPCs and Home's own tools write it
  ([`HomeService`](../../apps/server/src/home/HomeService.ts)).
- The grant is "the calling thread is `home.threadId`", read on every Home tool call
  ([`homeAccess.ts`](../../apps/server/src/mcp/homeAccess.ts)). No credential carries it, so turning
  Home off or starting fresh revokes the old thread at once; the old run is then interrupted with
  `holdQueue` so queued turns cannot start after it.
- Home threads are full-access with ids prefixed `home:`. The prefix lets any client label Home
  without reading settings, and it gates discovery: Home's tools use `McpSchema.EnabledWhen` on the
  prefix, so ordinary threads never list them and pay no context for them. The prefix is not the
  grant; a stale `home:` thread is refused at call time.
- Home reaches other machines only through the ordinary T3 tools with `environmentId`, which
  forward over Linked environments. There is no separate fleet relay.

## Home's folder

Home runs in `<T3 home>/home/`, whose `AGENTS.md` tells the agent it is Home. Any other thread
there would read those instructions and act as Home, so launches into that folder are refused
unless the thread id is a Home id, `create_threads` is refused for a Home caller, and Home cannot
be forked. Home must name a project or use `scratch: true`.

## Watches

[`HomeWatchReactor`](../../apps/server/src/home/HomeWatchReactor.ts) subscribes to the
`MilestoneHub` and wakes Home with a queued message when a watched thread or workflow run reaches a
milestone. The message's command id derives from the milestone id, so a repeat replays the first
send instead of waking Home twice. A watch ends when its thread's turn or its run settles. Threads
Home launches here are watched automatically.

Milestones are local, so watches cover this environment's threads and runs only. Home follows work
it started on a linked environment with `t3_thread_wait` or `t3_thread_read`.
