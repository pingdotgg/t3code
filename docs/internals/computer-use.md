# Computer use

The environment server is the authority over every step on a connected
computer ([ComputerService](../../apps/server/src/computer/ComputerService.ts)).
The helper on that computer runs the loop and acts only on a grant. This page
records the decisions the code cannot show.

## Approvals are not runtime requests

Provider approvals are `runtime-request` records, and the MCP gateway's
`t3_respond_to_approval` lets an agent answer them. A computer approval must
never be answerable by an agent, so it lives outside that pipeline: in memory
in [ComputerApprovals](../../apps/server/src/computer/ComputerApprovals.ts),
answered only through `computer.respondToApproval`, which needs the
`computer:approve` scope and has no MCP tool. Do not route computer approvals
through runtime requests or add a tool that answers them.

The in-memory store is deliberate. A server restart forgets pending approvals,
so a tap given before a restart can never grant a step after it. It is also why
push notifications do not cover computer approvals yet: the push notifier reads
projected thread state, and computer approvals are not projected.

An approval is bound to a digest of host, task, step, app, window title, URL
and the exact action, lasts 60 seconds and is taken once. The helper observes
the screen again after a tap and refuses to act if the control changed.

## Background first

Every step is done without the person's pointer, focus or keyboard: an
accessibility action, a value set and read back, or input posted to the app's
own process. Only then can the local stop ignore the person's own input and
let them keep working. A step that needs the real pointer is therefore the
person's to lend: it asks even with approvals off, and only during that step
does their movement count as taking over.

## The helper is a forked Node child

macOS attaches Accessibility, Screen Recording and Automation grants to the
app responsible for a process. The helper is forked with `process.execPath`
and `ELECTRON_RUN_AS_NODE=1`, so the grants belong to Ada.app, or to the
terminal that runs a standalone `ada serve`. Electron's `utilityProcess` and its
Helper executable do not carry the app's Accessibility grant. A child also
keeps a hung `osascript` or a crash out of the main process, and its death
ends the task.

The desktop host is relayed through the renderer, which already holds an
authenticated connection to every environment; desktop main does not. The cost
is that a computer is offered only while the Ada window is open. A desktop's
bundled server never forks its own helper (`computerLocalHost: false`), so one
Mac has one helper.

## Threat model

Approvals guard against mistakes and prompt injection from screen text, which
is data and never instructions. Every model that reads the screen can be
steered by it, so no model's verdict grants a step: a click the deterministic
policy cannot show is safe always becomes a tap. No accessibility role clears a
click on an untrusted surface, since a `tab`, `row` or `textbox` can still send. The decision endpoint only
chooses the next step, and the server sends it an allowlisted, capped state,
never what the host put there beyond it. The goal goes with it, so a goal
that contains the task's `text` is refused. Only that `text` is ever typed
(without one, only the exact address the helper's navigation parser reads
from the goal). It is kept out of the decision endpoint, read-only snapshots,
logs, errors and the audit file. A field value the helper echoes
(`containing “…”`) is dropped when it holds the text, and text of three
characters or more is replaced wherever else it appears. Shorter text cannot
be told apart from ordinary words: labels keep it, so a "No" button stays
visible, and screen text that holds it is left out whole. A read-only client's
approval is redacted when the approval is made, so it stays redacted after its
task is gone.

A host is bound to the authenticated session that connected it. Host calls
from any other session are refused, and only that session's reconnect
replaces it. A stopped task keeps its host reserved until the host reports
the task finished, and a control keeps it until the control's reply, since a
fixed control cannot be cancelled. A reply that arrives after its wait timed
out still frees the host. A host that has not let go within the reply
timeout of a stop is disconnected, which for a standalone server stops the
helper so its session can start again.

Approvals do not stop a full-access agent with a shell on the same machine as
the helper: it can run `osascript` itself. The boundary is real only when the
server and the controlled computer are different machines, or the agent has no
shell there.
