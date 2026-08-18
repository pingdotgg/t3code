# A generic ACP driver

> **Fork-local design.** Specific to the `s243a/t3code` fork. Unlike the rest of
> `docs/fork/`, this one is written to be upstream-able: it implements only the
> open Agent Client Protocol and names no vendor in its core.

## Why not reuse an existing driver

Pointing T3 at an arbitrary ACP agent through an existing driver's `binaryPath`
works right up to model discovery, then fails: the Cursor driver calls
`cursor/list_available_models`, and `CursorAdapter.ts` (1188 lines) also carries
`cursor/ask_question`, `cursor/create_plan`, and `cursor/update_todos`. Those
are vendor extensions, not ACP. Satisfying them would mean impersonating another
vendor's product — a facade over a surface we do not control and cannot track,
in a public repository, for no benefit.

The right answer is a driver that speaks **only** what the protocol defines.

## What is already generic

Most of the work exists. `AcpSessionRuntime` (1005 lines) is vendor-neutral and
already exposes the whole protocol surface:

| Concern     | Provided                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle   | `start`, `prompt`, `cancel`                                                                                                           |
| Selection   | `setModel`, `setSessionModel`, `setMode`, `setConfigOption`                                                                           |
| Output      | `getEvents` stream, `getModeState`, `getConfigOptions`                                                                                |
| Client role | `handleRequestPermission`, `handleElicitation`, `handleReadTextFile`, `handleWriteTextFile`, terminal create/output/wait/kill/release |
| Extensions  | `handleExtRequest`, `handleUnknownExtRequest`, and notification equivalents                                                           |

`AcpCoreRuntimeEvents` supplies the event constructors T3's orchestration
consumes — request opened/resolved, plan updated, tool call, assistant item,
content delta — none of them vendor-flavoured.

The vendor adapters are large because they bolt extensions onto this core, not
because the core is insufficient. A driver that skips extensions skips most of
the bulk.

Note especially `handleUnknownExtRequest`. The runtime already anticipated
agents sending methods it does not know. That is the seam vendor behaviour
belongs behind — and it argues the generic driver is the shape the ACP layer was
built for, not a shape being forced onto it.

## What a generic ACP agent actually wants

Designed from the protocol's client role rather than from what existing drivers
happen to do.

**To be launched the way it expects.** A command, arguments, environment, and a
working directory. Nothing more — an agent that needs a magic flag is describing
configuration, not a code path.

**To know what the client will do on its behalf.** ACP negotiates client
capabilities at initialize, and they are genuine choices, not formalities:

- _Filesystem_ — will the client perform reads and writes the agent requests?
  Saying yes routes file access through the client, where it can be shown,
  audited, and refused. Saying no means the agent touches the disk itself and
  the client never sees it.
- _Terminal_ — will the client run commands for the agent? Same trade.

These are the single most consequential settings, because they decide whether
the client is a window onto the agent's work or a participant in it. They
deserve to be explicit and per-agent, not inferred.

**To be asked for permission in a way it can answer.** Handled by the runtime
already; the driver's job is to forward decisions faithfully and never invent an
approval.

**To advertise its own models.** Core ACP returns them in the session response.
An agent that reports none is not broken — it may genuinely have one mode — so a
static override belongs in configuration rather than a failure path.

**To be resumed.** `session/load` when the agent supports it, and to be told
plainly when it does not, rather than silently starting fresh.

## Configuration

The core stays generic and vendor knowledge lives in **data**:

```
command            required
args               default []
env                default {}
authMethodId       optional — omit when the agent needs no authenticate step
capabilities       { filesystem: bool, terminal: bool }
models             optional static list, when the agent advertises none
profile            optional name selecting a preset of the above
```

A **profile** is a named bundle of exactly those fields. Adding support for a
new agent is a config entry, never a new adapter — which is the property the
vendor drivers lack and the reason they are the size they are.

The rule that keeps this honest: **a profile may only set values a user could
have typed by hand.** The moment a profile needs code, it is no longer a profile
and the extension belongs behind `handleUnknownExtRequest`.

This is also the part worth sharing beyond T3. The protocol says how to talk to
an agent but not how to _launch_ one, so every client reinvents that. A profile
format is portable in a way an adapter is not.

## Mapping to T3

`ProviderAdapterShape` has thirteen members. Most are bookkeeping over a
`threadId → runtime` registry: `listSessions`, `hasSession`, `stopSession`,
`stopAll`, `startSession`. The protocol-facing ones — `sendTurn`,
`interruptTurn`, `respondToRequest`, `respondToUserInput`, `streamEvents` — map
onto runtime calls that already exist.

Two need judgement rather than plumbing:

- `readThread` — ACP has no history-read call. Serve T3's own record; do not
  fabricate one from the agent.
- `rollbackThread` — T3 checkpoints by diffing the workspace, so this must not
  try to rewind the agent's internal state. Report unsupported honestly.

`capabilities.sessionModelSwitch` follows from whether the agent answered
`setSessionModel`, discovered at runtime rather than declared per vendor.

## Deliberately not doing

- **No vendor methods in the core.** Not `cursor/*`, not any other. Unknown
  extensions are logged and declined, never guessed at.
- **No pretending to be another binary.** If an agent needs a probe answered,
  that is the agent's job, not ours to fake.
- **No model menus we cannot honour.** Advertise what the agent reports or what
  the user configured; nothing else.
- **No hidden capability grants.** Filesystem and terminal are off unless
  configured on. A driver that quietly says yes to both has decided a security
  question on the user's behalf.

## Open questions

1. Does `AcpSessionRuntime.start` require an `authMethodId`, or tolerate its
   absence? Its options type lists it as required, which may need a small
   upstream change for agents with no auth step.
2. Where do profiles live — settings, or files a user can drop in? Files are
   friendlier to share; settings are simpler to validate.
3. Should filesystem and terminal capabilities default off? Safer, but every
   agent then needs configuration before it does anything useful.
