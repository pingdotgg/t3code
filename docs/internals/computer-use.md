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

## The helper is a forked Node child

macOS attaches Accessibility, Screen Recording and Automation grants to the
app responsible for a process. The helper is forked with `process.execPath`
and `ELECTRON_RUN_AS_NODE=1`, so the grants belong to Ada.app, or to the
terminal that runs a standalone `t3`. Electron's `utilityProcess` and its
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
is data and never instructions. The party that chose a click has read the
page, so it never judges whether that click is safe: a click the policy cannot
settle goes to the configured decision endpoint, which sees only the goal, the
window and the control, and otherwise becomes a tap. Only the `text` a task was
started with is ever typed, and it never reaches the decision endpoint, a log,
an error or the audit file.

Approvals do not stop a full-access agent with a shell on the same machine as
the helper: it can run `osascript` itself. The boundary is real only when the
server and the controlled computer are different machines, or the agent has no
shell there.
