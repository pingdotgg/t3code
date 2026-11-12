# Workflows

A workflow run is a journaled function: each step happens once, a restart replays the run to where
it was, and a run sleeps on a wait until something outside signals it. The code is in
[`apps/server/src/workflows`](../../apps/server/src/workflows). This page holds what is not
obvious from it.

## Why it is shaped this way

**The engine is Effect's, in the server's database.** `effect/workflow` on one runner journals
runs in tables it creates itself. Runs, steps, waits and kept signals are rows of ours beside them,
not orchestration events: the event store knows projects and threads, a run is neither, and its
journal is the engine's to read. Clients follow runs the way they follow scheduled tasks, by a
list that is sent again when something changes.

**Off unless asked for.** The server registers the definitions exported by the module named in
`T3CODE_WORKFLOWS`. Without it the `Workflows` service is the disabled one and the engine's modules are never
imported
([`WorkflowRuntime.ts`](../../apps/server/src/workflows/WorkflowRuntime.ts)). Keep it that way:
anything a light module imports from `effect/workflow` or `effect/cluster` is paid for by every
server and CLI start.

**A step failure pauses the run.** The alternative, ending the run, loses everything done so far to
a dependency that is back in a minute. Resuming runs the failed step again and nothing before it.
A step that wants its workflow to decide about a failure returns the failure as data. `stop` is the
workflow's own decision to end, and is not a failure.

**An agent step is a thread.** It completes when the agent submits a result the server checked
against the step's schema, not when a turn ends, and a person can open the thread and talk to it.
See [typed results](../orchestration-v2/orchestrator-mcp-server.md#t3_submit_output).

**A run stays where it started; its agents need not.** An agent step that names a linked
environment runs its thread there through that environment's own thread tools, with the step's key
as the request id, so a replay finds the thread it already started. The run is no agent and has no
modes to pass on, so the link's access is the only ceiling on what it starts there. Making and
linking machines is the workflow author's own code in a `step`; nothing here knows how.

**`onEnd` gets the payload and the run's id, not the body's values.** A cancelled run's body is
gone, so its cleanup runs outside the engine and has only what the run was started with. Inside
the engine `onEnd` is an ordinary last step.

## Traps

**A workflow body is replayed.** After a restart or a wait, the body runs again from the top and
each journaled action returns what it stored. Anything that touches the world goes through
`journaled` (`step`, `agent` and `wait` are built on it). Code between steps must give the same
answer on every pass: no clock, no randomness, no reads.

**Names are the journal's keys.** A step's result and its row in the step list are both kept by
name, so two steps with one name would share a result. `claim` rejects that, across kinds. A change
to the order of steps, or to the shape a step returns, is a new `version` of the workflow; keep the
old one registered until its runs have ended. A run whose version is gone shows as `retired`.

**The engine reads integers as BigInt, and nothing else may.** It stores 64-bit ids, which
`node:sqlite` only reads when asked for BigInts, so the engine's fibers and every call into it run
with `SqlClient.SafeIntegers` on. That setting is inherited by whatever those fibers call.
`journaled` turns it off again around a step's own code; without that, a step that reads a project
gets rows it cannot decode.

**The pause is recorded in two places, a moment apart.** A failing step marks its run paused from
inside the engine, just before the engine records the failure. `resume` waits for the engine's
record, or it would resume a run the engine does not yet consider stopped and do nothing. The sweep
puts back a run that still says `running` while the engine holds it as failed.

**A step in flight cannot be interrupted.** The engine runs a step's body to its end. `cancel`
therefore ends the run's row first, so nothing the step still does is recorded as the outcome, and
stops the agent's thread, which is what makes a long agent step return.

**One signal wakes one wait.** A wait is taken by the first signal for it; a second signal on the
same key is for the next run that waits on that key, and is kept until one does. A signal's id is
remembered once delivered, so a sender's retry is not a second signal.
