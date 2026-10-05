# Home

Home is one agent thread per desktop install that acts with the user's reach
across every project and connected environment. User guide:
[Home](../user/home.md).

## Where it runs and who may act

- Home runs on the desktop's local server, the hub. Only a server with
  `mode: "desktop"` offers it (`ServerConfig.homeWorkspaceRoot` is present).
- Its state lives in `ServerSettings.home` so every client gets it with the
  settings stream. Clients cannot patch it: the WebSocket settings update drops
  `home`, and only the Home RPCs and Home's own tools write it.
- The grant is "this thread is `home.threadId`", read on every MCP call in
  `mcp/homeRouting.ts`. Turning Home off or starting fresh revokes the old
  thread's reach at once, then holds its queue (`queue.hold`, under the
  orchestrator's thread lock) and interrupts its active run. Fleet operations
  check the grant again right before they act. No credential carries it.
- Home threads are always full-access. The MCP mode check stops a caller from
  acting on a thread broader than itself, and approvals need the widest mode.
  Every change Home makes, local or relayed, is checked on the hub with
  `readHomeChangeCaller`: a live Home run in full-access/default mode. A user
  who switches Home to plan mode makes it read-only everywhere.
- Home never launches into its own folder. That folder's AGENTS.md tells the
  agent it is Home, so Home must name a project or pass `scratch:true`.
- Home thread ids start with `home:` so any client can label Home's messages
  without knowing which environment sent them.

## Reaching other environments

Every server runs `FleetService`, which executes a fixed set of operations with
the user's reach: no calling-project limit, no deletes. Home's tools call it in
process for the hub, and through `fleet.invoke` everywhere else.

The hub cannot call other servers itself. The credentials it would need live in
the desktop renderer: T3 Connect tokens are bound to a non-extractable renderer
key, SSH sessions mint per connect, and desktop sessions lack `access:write` to
mint narrower ones. So the renderer relays: it registers on the hub with
`fleet.connect` and its current list of environments, runs each request with
`fleet.invoke` over its existing connection, and answers with `fleet.respond`
(`home/FleetBroker.ts`). The newest registration wins.

Consequences:

- Home reaches other environments only while a desktop renderer is alive. On
  macOS the window hides instead of closing while Home is on.
- `fleet.invoke` needs only `orchestration:operate`, which already grants
  everything it does. Older peers without it fail with `environment_unavailable`.
- Results cross the relay untyped and are decoded on the hub per operation
  (`FleetResults`), so the renderer stays a dumb pipe.

A hub credential per peer would let Home run headless. It needs a relay-side
"peer mint" for T3 Connect and a pairing step for the rest.

## Watches

Home is woken by watched thread changes, not by polling. Watches live in
`ServerSettings.home`. Threads Home launches are watched automatically with
reason `launched`.

The renderer evaluates watches, because it already streams thread shells from
every environment. It uses the same transitions as desktop notifications
(`components/home/homeWatch.ts`), batches events briefly, and reports them with
`fleet.reportWatchEvents`. `HomeService.report` drops unwatched events, ends
watches on settle or archive, and sends one message into Home's thread with
`mode: "auto"`, which steers an active turn or queues behind it.

Two traps in the watch diff. Archived threads leave the shell list instead of
showing `archivedAt`, so a watched thread missing from a live environment's
list counts as ended; a cached or offline list proves nothing. And watching
everything may already hold a silent baseline for a thread when its launch
watch arrives, so a launch watch added while the app runs compares the thread
with an empty state the first time it sees it.

The hub picks the id of every thread Home launches, with the
`home-launched:` prefix, and saves the launch watch before the launch starts.
While Home is on, clients skip notifications for prefixed threads. The prefix
travels with the thread, so this does not depend on settings reaching the
client before the thread does; separate streams give no such order.
