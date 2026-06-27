# Epic 27: Scheduled Workflows (Routines)

## Purpose

A workflow today runs when a user launches it, and it can suspend awaiting a reply (Epic
25 §The Handle pattern). This epic adds the other wake trigger: **the clock.** A workflow
can sleep until a specific date/time, which makes two things possible — a one-off timer
("open this back up Monday morning") and a **routine** (a loop that does work, waits,
does it again).

A routine is just a workflow that loops on a timer. The thread it runs in _is_ its
visualization — it mostly sleeps, wakes on its timer, posts what it did, sleeps again.
There is no "automations panel": a routine is a thread that lives in the sidebar, dormant
until its next wake.

This epic is deliberately small. It builds entirely on Epic 25's durable suspension — a
run that survives a server restart is the hard part, and it is already shipped (the
DB-backed `workflow_runs` / `workflow_journal` tables, the boot-time rehydration). Routines
add **one** new primitive and **one** new service: `waitUntil` and a clock-based wake.

## Why now

The engine can already park a run for an unbounded time and resume it from the DB. The
only wake path is the **event reactor** — a run suspended on `askUser` / `askAgent` wakes
when a matching orchestration domain event lands (a user reply, a completed turn). That
covers human-in-the-loop, not time.

`wait(durationMs)` (Epic 25 §Other primitives) journals a deadline, but nothing _causes_
the resume at that deadline — it relies on the run still being in-process. There is no
component whose job is "wake parked run X when the wall clock reaches T." That component —
a **scheduler** — is the missing piece, and it's what turns a parked run into a timer.

## The model: a loop with `waitUntil`

The engine is replay-based durable execution. In that world, recurrence is not a
host-managed schedule — it's a loop in the workflow body, the same way it would be in
Temporal/Restate. There is no separate "schedule" concept to learn.

A complete routine is an ordinary `.workflow.ts` (Epic 25 file shape) whose body loops:

```ts
// .t3work/routines/weekly-triage.workflow.ts
import { Schema } from "effect";
import { jiraRead, jiraWrite } from "@t3work/sdk/groups";
import { nextWeekday } from "@t3work/sdk/time";

export const Inputs = Schema.Struct({}); // no launch args — it just runs

export const meta = {
  name: "weekly-triage",
  description: "Each Monday, triage the week's new bugs and flag blockers to me.",
  inputs: Inputs,
  capabilities: ["schedule", "user", jiraRead, jiraWrite],
  phases: [{ title: "Wait" }, { title: "Triage" }] as const,
} as const;

const TriageResult = Schema.Struct({
  assignments: Schema.Array(Schema.Struct({ id: Schema.String, assignee: Schema.String })),
  needsHuman: Schema.Array(Schema.Struct({ id: Schema.String, why: Schema.String })),
});

while (true) {
  phase("Wait");
  // `now()` is the journaled clock; nextWeekday is a pure transform → replay-safe.
  await waitUntil(nextWeekday(now(), { weekday: "monday", at: "09:00", tz: "Europe/Zurich" }));

  phase("Triage");
  // A search tool returns a `ResourcePage`; its `items` are already `ExternalResourceRef`s.
  const bugs = await tools.jira.searchIssues({
    jql: "type = Bug AND status = New AND created >= -7d",
  });
  if (bugs.items.length === 0) continue;

  // Isolate this week's reasoning in its own child thread; the routine thread stays a clean log.
  const run = spawnThread({ name: "Triage" });
  const result = await run.askAgent(
    "Triage these new bugs: sort by severity, assign the clear ones to the right engineer, and list any that need a human decision.",
    {
      schema: TriageResult,
      // Attach the refs the search returned, as-is. The context layer resolves each to a
      // live snapshot for the agent — nothing hand-built, nothing inlined into the prompt.
      attachments: bugs.items,
    },
  );

  // The clear ones: act, then a navigable heads-up. notify is fire-and-forget but still
  // carries attachments — the user clicks straight through to each bug; it just doesn't wait.
  for (const a of result.assignments) {
    await tools.jira.assignIssue({ id: a.id, assignee: a.assignee });
  }
  const assigned = bugs.items.filter((b) => result.assignments.some((a) => a.id === b.id));
  if (assigned.length > 0) {
    await thread.notifyUser(`Assigned ${assigned.length} bug(s).`, { attachments: assigned });
  }

  // The ones needing a human call: ask, with rich UI — never a text dump of ids. The
  // attached refs render as bug cards; the schema renders as the choice buttons. This
  // suspends the routine until you answer (the sidebar shows "waiting for you"), then it
  // acts on your decision and loops back to sleep.
  const flagged = bugs.items.filter((b) => result.needsHuman.some((n) => n.id === b.id));
  if (flagged.length > 0) {
    const decision = await thread.askUser(
      "These bugs need your call — assign them to the platform team, or hold for review?",
      {
        attachments: flagged,
        schema: Schema.Struct({ action: Schema.Literals(["assign-platform", "hold"]) }),
      },
    );
    if (decision.action === "assign-platform") {
      for (const b of flagged)
        await tools.jira.assignIssue({ id: b.id, assignee: "platform-team" });
    }
  }
}
```

A one-off timer is the same `waitUntil`, without the loop:

```ts
const DAY = 24 * 60 * 60 * 1000;
await waitUntil(now() + 3 * DAY); // `now()` is the journaled clock → deterministic
await thread.notifyUser("Reminder: the BUG-241 fix is still awaiting review.");
```

_(Tool names — `tools.jira.searchIssues`, `tools.jira.assignIssue` — follow the
`tools.<group>.<name>` convention from Epic 25; the exact catalog is in
[Epic 21](./21-context-tool-catalog.md).)_

What's **injected** vs **imported** in that file (Epic 25 §Globals):

- **Injected globals — no import, in scope automatically:** `args`, `now`, `waitUntil`,
  `phase`, `log`, `tools`, `scripts`, `agent`, `spawnThread`, and `thread` (the run's own
  thread — for a routine, the thread you watch it in; `undefined` only for a truly headless
  run with no chat surface). `askAgent` / `askUser` / `notifyUser` / `notifyAgent` are
  methods on a thread (`thread.*`, or the handle from `spawnThread()`). `askAgent(prompt,
opts)` / `askUser(question, opts)` take `{ schema?, model?, attachments? }` —
  `attachments` is how context is passed: typed references (`ExternalResourceRef`s for
  issues / PRs / pages — exactly what the search/read tools return — plus file/url kinds),
  which the context layer resolves to live snapshots, **never inlined into the prompt**.
  `notifyUser(text, { attachments? })` is fire-and-forget — it can carry attachments so the
  user clicks straight through to a bug/PR, it just doesn't await a response. `askUser`
  is the same but awaits a typed answer (`schema` → choice affordances, `attachments` →
  resource cards). The ask-vs-notify split is _awaits-a-response or not_; both render
  richly. A string of ids is never the answer.
- **Imported — allowlisted pure modules only:** `Schema` from `effect`, capability groups
  from `@t3work/sdk/groups`, and the time helpers from `@t3work/sdk/time`.

Three properties fall out, and all three are the author's choice, not the engine's:

- **Unbounded is allowed.** A loop that never returns is a valid workflow. The thread
  accumulates its history.
- **State across fires is free.** A `let count = 0` in the loop survives every wake (it's
  in the journal, replayed on resume). No external store needed.
- **Isolation is opt-in.** Want each fire to be its own clean conversation? `spawnThread`
  inside the loop. Want them to share one running context? Don't. The default is "share."

"Skip missed fires" vs. "catch up" is likewise just author logic: compute the next
_future_ time to skip, or don't to catch up. The engine has no catch-up policy because
the body already expresses it.

### `waitUntil(when)`

A body primitive, sibling to `wait(durationMs)`. Suspends the run until a wall-clock
instant, then resumes from the journal.

```ts
await waitUntil(deadline); // absolute instant (epoch millis or ISO)
await waitUntil(now() + 3 * DAY); // relative to the journaled clock
```

Like `wait`, the resolved instant is **journaled** on first execution, so replay is
deterministic — `waitUntil` reads the recorded deadline on resume, never the live clock.
The one thing it adds over `wait`: it registers the deadline with the **scheduler**, so
the run is actually woken at that instant even after the process slept or restarted.

That is the entire author-facing surface. No `meta.schedule`, no cron, no decorators.

### Time & scheduling helpers

We don't build our own date math — we lean on what's already in the stack. `effect`
(already on the body's import allowlist) ships `effect/DateTime`, which is tz-aware and is
what the engine's journaled clock is already built on. So tz-correct calendar logic needs
no new core dependency.

The SDK wraps the common cadences in an allowlisted pure module, `@t3work/sdk/time`, so
authors don't hand-roll them:

```ts
import { nextWeekday, nextCron } from "@t3work/sdk/time";

nextWeekday(now(), { weekday: "monday", at: "09:00", tz: "Europe/Zurich" }); // → epoch millis
nextCron(now(), "0 9 * * 1", { tz: "Europe/Zurich" }); // cron, via cron-parser
```

The one replay-safety rule, and the reason every helper takes `now()` as its first
argument: **a time helper must source "now" from the journaled clock, never read the real
clock itself.** Pure transforms (instant in → instant out) are always safe. The trap is a
library's own clock read (`DateTime.nowUnsafe()`, a cron lib's internal "now") — it
bypasses the journal and diverges on replay. So `@t3work/sdk/time` helpers are pure
functions of the instant you pass in; authors who reach for `effect/DateTime` directly
(allowlisted, fine) must likewise build from `now()`, not from `DateTime.nowUnsafe()`.

`nextWeekday` is backed by `effect/DateTime`; `nextCron` adds `cron-parser` (a small, pure
dependency). Neither reads the clock — they transform the journaled instant.

## The scheduler service

The one new host component — a peer to the event reactor. Where the reactor wakes parked
runs on domain events, the scheduler wakes them on the wall clock.

1. **Own durable wake deadlines.** When a run suspends on `waitUntil`, its wake instant is
   recorded on the run (a `wake_at` column). The scheduler is the index of "which parked
   runs are due, and when."
2. **Fire at the deadline.** Arm a process timer for the soonest pending `wake_at`
   (re-arming as runs park/wake). At fire time, for the due run: `appendResolvedEntry` for
   the wait's correlation id, then `resumeWorkflow` — the exact path the event reactor
   uses, just clock-triggered instead of event-triggered.
3. **Re-arm on boot.** In `serverRuntimeStartup`, alongside Epic 25's workflow-run
   rehydration, the scheduler queries all runs with a future (or past-due) `wake_at` and
   re-arms them. This is the durability guarantee: a timer set before a restart still
   fires after it. A deadline that _passed_ during downtime fires immediately on boot.

The scheduler is the only clock authority. Workflow bodies never read the wall clock to
decide timing (they read the journaled `now()`); the scheduler reads the real clock and
pokes the engine. That keeps replay deterministic while still being time-driven.

## Persistence

Minimal — no new table. Epic 25's `workflow_runs` gains:

- **`wake_at`** (nullable ISO) — the instant a clock-parked run is due. The scheduler's
  index. Null for runs not parked on a timer.
- A **`sleeping`** value in the existing `status` enum — distinguishes a clock-parked run
  from an input-parked `suspended` one, so the UI can show "sleeping until Mon 9:00" vs
  "waiting for you." The journal already carries everything needed to resume; `wake_at` +
  `sleeping` are just the scheduler's and the UI's view of it.

## The thread is the UI

A routine has no dedicated surface — it is a thread, following the interactive-thread
model (composer as universal input, thread as canvas, agent emits widgets inline — see
[§References](#references)). Its rendering, from the design pass:

- **State pill** — `Sleeping` / `Running` / `Waiting for you`, with the next wake
  ("sleeping until Monday 9:00 · wakes in 3 days · survives restarts"). The next-wake time
  comes straight from the run's `wake_at`.
- **Run history** — the loop's past iterations read as a timeline: what each wake did,
  anything it flagged. A fire that paused for input shows the same decision card any
  interactive run would (a routine can `askUser` mid-loop).
- **Run now** — wake the parked run early (resume before `wake_at`), off-cycle.
- **Composer adjusts it** — the universal-input principle: "skip next week", "run hourly
  instead", "also pull from Linear" are typed into the composer. For the schedule to be
  adjustable at all, the loop should read its cadence from a mutable source it re-reads
  each iteration (project config / the routine's own state) rather than hardcoding it —
  then editing that config takes effect on the next wake. That's an author pattern, not an
  engine feature.

In the sidebar, a sleeping routine sits among the threads with a clock glyph and its
next-wake time, distinct from active and input-waiting threads.

## Lifecycle operations

- **Run now** — resume the parked run before its `wake_at`.
- **Pause / resume** — pause clears the scheduler's arming for that run (it stays parked,
  not woken); resume re-arms it for its `wake_at` (or the next computed one).
- **Edit cadence** — via composer, _if_ the routine reads its schedule from mutable config
  (see above). A routine that hardcodes its cadence isn't editable without changing the
  workflow.
- **Delete** — follows the thread-deletion cascade: deleting the thread deletes the run +
  its journal.

## Capability and limits

- **`"schedule"` capability** — a workflow that calls `waitUntil` must declare the
  `"schedule"` capability (Epic 25 §Capability gating). It surfaces in the pre-execution
  permission view ("this can run on a timer, even when you're away") — running unattended
  is a power the user should authorize knowingly.
- **Frequency floor** — a minimum sleep (e.g. 1 minute). A `waitUntil` resolving to an
  instant less than the floor away — or a loop that effectively busy-waits — is a runaway
  guard, surfaced as a warning. (This is the one thing the loop model can get wrong that
  the engine should catch: a `while(true)` with too-short or zero waits.)
- **Per-project sleeping-run cap** — a soft ceiling on concurrent sleeping routines, to
  keep the scheduler's deadline set and the sidebar bounded.

## The one scaling caveat: unbounded journals

An immortal loop's journal grows forever — every `waitUntil` / `agent` / tool call in
every iteration appends an entry, and replay-on-resume re-runs from the top. For a routine
that has fired weekly for a year, that's a large journal to replay on each wake.

This is acceptable for now (unbounded threads are explicitly fine), and it's the standard
durable-execution problem with a standard answer: **continue-as-new / checkpointing** —
periodically collapse completed iterations so replay starts from a checkpoint, not the
top. Deferred. It does _not_ change the author model (the loop stays a loop); it's an
engine optimization that bounds replay cost when it eventually matters. Flagged here so
the journal/replay layer isn't designed in a way that precludes it.

## Implementation phasing

Builds on the shipped Epic 25 engine + durability.

| Phase | Scope                                                                                         | Status   |
| ----- | --------------------------------------------------------------------------------------------- | -------- |
| 27.1  | `waitUntil(when)` primitive — journaled deadline, records `wake_at` on the run                | Planned  |
| 27.2  | Scheduler service — arm soonest `wake_at`, fire → resume, re-arm on boot (the core new piece) | Planned  |
| 27.3  | `sleeping` status + `wake_at` column + dormant-thread UX (state pill, run history, run-now)   | Planned  |
| 27.4  | Lifecycle (pause/resume/run-now) + `"schedule"` capability + frequency floor                  | Planned  |
| 27.5  | Continue-as-new / journal checkpointing — only when long-lived routines make replay cost real | Deferred |

27.2 is the load-bearing build — once the scheduler can durably wake a parked run on the
clock, the one-off timer and the routine loop are both just `waitUntil`.

## Open questions

1. **Scheduler precision vs. cost.** A single soonest-deadline process timer is cheap but
   needs careful re-arming; a polling loop is simpler but coarse. Decide in 27.2; precision
   beyond ~1s isn't a requirement for any routine use case here.
2. **Editable cadence ergonomics.** "Edit via composer" only works if the loop reads its
   schedule from mutable config. Should the SDK offer a small helper for that common
   pattern (a `routineConfig` the loop reads + the composer writes), so authors don't each
   reinvent it? Lean yes, but defer until a couple of real routines exist.
3. **Runaway detection.** The frequency floor catches the obvious `while(true)` with zero
   waits. Are there subtler runaway shapes (a loop whose `waitUntil` always resolves to the
   past) that need a per-run "woke N times in M minutes" circuit breaker?
4. **Multi-instance.** Single-instance is assumed (Epic 25). A replicated deployment needs
   exactly one scheduler firing each deadline (a lease/leader), else a run wakes N times.
   Out of scope now; noted so the scheduler isn't designed in a way that blocks it.

## References

- [Epic 25: Workflow Engine](./25-workflow-engine.md) — durable suspension, `wait`, the
  determinism contract, and the DB-backed run/journal tables this builds on.
- The event reactor (`apps/server/src/t3work-workflowEngineReactor.ts`) — the existing
  event-based wake path the scheduler is a clock-based peer to.
- **Interactive-thread model** — the thread-as-canvas, composer-as-universal-input,
  agent-emits-widgets-inline model the routine UX follows. Currently captured in the design
  pass + the project memory (`project_t3work-recipes-architecture`), **not yet a standalone
  doc** — link this once it lands as one.
