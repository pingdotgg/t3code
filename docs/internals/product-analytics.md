# Product analytics

The server owns analytics delivery, opt-out, and identity for every connected client.
Clients do not load the PostHog browser SDK. Client-use events require an
authenticated connection, so visiting the hosted app without connecting does not
count as product use.

## Installs and owners

`distinct_id` keeps the rule every build has used: the hashed Codex workspace,
else the Claude machine id, else the install's anonymous id. It can change when
someone logs in, and a Codex Team shares one, but keeping it means PostHog charts
and history never break. Do not change it; add a field instead.

Every event also carries `installId` when the server can save its state: the hash
of a random id in the state directory, which never changes for the install. If
that file cannot be written, events still go out under `distinct_id`, as before. Count installs
with it. Who an install belongs to is a separate fact, sent as
`install.owner_observed`. Owners are resolved at query time in our own store, so
a rule can change and apply to all history.

[Owner sources](../../apps/server/src/telemetry/Identify.ts), strongest first:
T3 Connect, then the OpenAI and Claude person ids, then the client device. The
server reports what it can read itself: the linked Connect account and provider
logins. A connecting client reports its signed-in Connect account and its device,
which links every environment opened from one phone, browser, or desktop. Use the
OpenAI `user_id` claim, not the Codex `account_id` (the ChatGPT workspace, which a
whole Team shares) or the token `sub` (one per login method). Two Connect accounts are never the same person, whatever
weaker ids they share.

Every id is SHA-256 hashed with [one helper](../../packages/shared/src/telemetryId.ts)
on both sides, so a Connect account hashes the same on the client and the server.
The server accepts only hashes from clients.

## Attribution boundaries

Client dimensions belong to the event's WebSocket connection. A server-global
"current client" would misattribute simultaneous web, desktop, and mobile use.
Provider execution has its own events because a turn can outlive the requesting
connection.

Keep client and server dimensions separate. A desktop host can serve a phone or a
remote browser, and a direct connection can cross a network. Older clients omit
metadata. Missing client values must stay unknown rather than being backfilled
from server properties. The legacy `clientType` property describes how the server
runs; use `surface` for the connected client.

## Interpreting events

Use `client.turn.requested` for active-use reports. There is no connection event,
because T3 Connect sessions expire hourly and each reconnect would count again.
A command whose id was already accepted is a retry, so it records nothing again.
One identity can appear in several client groups during a period; adding those
groups double-counts users.

Provider send and completion counts need not match. `provider.turn.completed`
is one provider turn, and `segment` says what started it: the run's first
attempt (`initial`), a `steering_restart`, a provider `continuation` such as a
Codex goal turn, or a `native_child` subagent. `createdBy`, `creationSource`,
`scheduled`, and `subagent` describe the run's starting message, and `childKind`
separates native subagents from T3-managed child threads. Use this event for
per-turn measurements, not for counting requests.

`provider.request.completed` is one run, recorded when the run settles in the
server process that ran it. It adds each root turn once, so continuations,
steering, and replayed provider events do not add rows. `requestKind: "user"`
counts what people asked for. Native subagent turns are summed apart from the
root (`childUsageStatus`, `childInputTokens`); T3-managed child threads report
their own requests as `t3_child`. A child still running at settlement is never
added later, and the summary sets `childrenRunning`. A server restart loses the
summary of a run in progress. A run that continues after a restart reports its
own usage with `restartContinuation` and `lifecycleObserved: false`; it cannot
recover the original request's count or kind. A run whose provider session never
opens has no summary, and a start the provider rejects reports
`providerTurns: 0`. A Stop that lands while a steering restart is starting ends
the run without a summary. Collection is best effort, with no scan or backfill of
provider history.

Counts cover the main agent. `otherInputTokens` and `otherOutputTokens` are what
a provider's own ledger recorded beyond it during the turn: Claude's per-process
`modelUsage` growth, which covers native subagents, compaction, and helper
calls. They need a baseline from the same process, so they stay absent when it
is unknown or the ledger goes backwards, and background work that ends between
turns lands in the next one. Claude subagents have no turns of their own, so
this never overlaps child turns.

`model` and `effort` are what the run selected. `observedModel` and
`mixedModels` appear only when the provider reported the models for the counted
work (Codex thread settings and reroutes, Claude root messages, OpenCode steps).
`mixedModels: false` without `reportVersion` was never checked. Model labels
come from the bundled model manifest and the Cursor and Grok catalogs, also for
routed ids such as `anthropic/claude-opus-5-5`, and efforts come from a closed
list, so user-configured names stay out.

Status and counters answer different questions. `usageReported: false` means
the adapter attached no usage; a harness where every row says so is unsupported,
not idle. `partial` keeps valid counts that cannot establish a whole-turn total,
such as an OpenCode step that ended without a report, an OpenCode stream
reconnect, or an interrupted segment.
Explicit zeros are sent and unknown counts stay absent. `localCommand` marks a
provider-local command such as Claude's `/compact`, whose result counters are not
model work. Reasoning tokens are a subset of output.

Charts built on these events should say "output tokens per measured provider
completion", compare matching provider, observed model, effort, interaction mode,
and terminal status, and show eligible and measured counts by harness, origin,
and status so unknown models and unsupported adapters stay in the denominator.
Divide summed totals for output/input ratios; averaging per-turn ratios lets
small-input turns dominate. Rows without `reportVersion` keep their missing
fields unknown; a missing origin is never a person.

`feature.used` counts WebSocket requests that start a feature. RPCs are observed in
the RPC authorization middleware after the request succeeds; dispatched commands
are recorded by the dispatch handler, which can tell a retry apart.
[Feature mapping](../../apps/server/src/telemetry/FeatureUsage.ts) allowlists
the methods and commands, and takes variants only from closed contract enums,
so paths, ids, and text never reach analytics. Guests of a shared thread have no
WebSocket connection, so the guest share service records their joins and messages
itself, with no `surface`.

Agent tool events report driver kinds, never instance ids: users name
instances, so an instance id can identify an account or employer.
[Provider dimensions](../../apps/server/src/telemetry/ProviderDimensions.ts)
report a model only when it is a non-custom entry in a vendor catalog. OpenCode,
Pi, and ACP agents list models from user configuration, such as local Ollama
tags, so their models stay out. Handoff settings come from closed enums and
booleans in tool arguments; prompts, titles, and ids are never read. Thread ids
are used only to look up the threads on each side and never leave the server,
which is also why tool events carry no per-thread sequence. A handoff to several
threads, such as `create_threads`, records one `mcp.tool.invoked` per target, each
repeating the call's outcome and duration, so event counts are not call counts.

## Delivery

The server sends batches to the ingest endpoint at `ingest.t3.codes`, which archives
every event and forwards some of them to PostHog. A send can fail after the endpoint
has stored the batch, so every retry is a copy.
[Delivery](../../apps/server/src/telemetry/AnalyticsService.ts) gives each event a
uuid when it is recorded (the endpoint rejects events without one), backs off after
a failed send, and drops a batch after a few tries. Without these limits, one stuck
batch was sent every second for days.

## Collection boundary

Keep analytics payloads to product metadata and normalized measurements. Do not
send prompts, authentication material, raw provider payloads, user-assigned device
names, or conversation identifiers. Client metadata is best effort; invalid values
must not reject a connection. PostHog person profiles remain disabled.

Dev-runner servers and the CI archive smoke test turn telemetry off, which also
stops relay tracing, because each would count as a new install. Set
`T3CODE_TELEMETRY_ENABLED=true` to test analytics or relay tracing from a dev server.
