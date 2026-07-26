# Advisor/Planner mode

Advisor/Planner is a consultative thread mode: the agent reads the workspace,
answers questions, explains how things work, reviews code and designs, weighs
tradeoffs and recommends a course of action — preferring not to change the
workspace itself while it does so. When the user configures a per-thread
**executor model**, the agent can also plan work and **delegate implementation
to executor sub-agents** through the `delegate_task` tool; those sub-agents
inherit the thread's stored runtime mode (write access depends on that mode).

It is the third value on the interaction axis (`default | plan | advisor`); the
wire literal is `"advisor"`. See [runtime-modes.md](./runtime-modes.md) for how
that axis relates to permissions.

## Advisor/Planner vs. plan

They look similar and are easy to conflate, so the distinction is worth stating
plainly.

|             | Plan                                                  | Advisor/Planner                                                         |
| ----------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Goal        | A decision-complete spec another agent can implement  | An answer, a plan of action, and optionally delegated implementation    |
| Output      | A `<proposed_plan>` artifact, rendered as a plan card | An ordinary chat reply (and optional sub-agent results)                 |
| Ends when   | You accept the plan and implement it                  | You switch interaction mode — stopping a request only ends the exchange |
| Enforcement | Prompt-level only — the sandbox is unchanged          | Prompt-level guidance — permissions follow the thread's runtime mode    |

Plan mode is a phase of doing the work that produces a handoff artifact.
Advisor/Planner is consultative: the parent is steered to advise rather than
edit. With an executor model configured, it delegates implementation to
sub-agents that run under the thread's stored runtime mode.

## Permissions are independent

Interaction mode (default / plan / advisor) is fully independent of runtime
permission mode. The user can run Advisor/Planner with Full Access, Auto-accept
Edits, or Approvals required. There is no permission clamp on advisor turns.

"Don't edit files yourself" is **prompt-level guidance** (developer instructions
and steering). Actual write access is purely the user's runtime-mode choice.

Invariants:

- The session uses the thread's stored `runtimeMode` for every interaction mode.
- **Delegated sub-agents always inherit the parent thread's stored
  runtimeMode**, with or without an executor model.
- **With an executor model**, `DelegateCoordinator` runs the child thread on
  that instance/model with `interactionMode: "default"`. This is an explicit
  user-opted-in path for delegated implementation.

## Executor configuration

Two per-thread fields on the thread read model and shell:

- `executorModelSelection: ModelSelection | null` — the executor model. Null
  means advise only (delegation falls back to the thread's own model).
- `executorMaxSubAgents: number` (1–10, default 3) — the max concurrent
  executor sub-agents, exposed in the mac composer as a slider.

- Command: `thread.executor-model.set` with `{ executorModelSelection,
executorMaxSubAgents? }` (`null` clears the executor → advise only; an absent
  `executorMaxSubAgents` keeps the current value).
- Event: `thread.executor-model-set` carrying both fields.
- Persisted as `projection_threads.executor_model_selection` (nullable JSON)
  and `projection_threads.executor_max_sub_agents` (integer, default 3).
- Not carried per-turn; read at delegation time from the parent thread
  projection.

When `DelegateCoordinator` services a `delegate_task` call from an advisor
thread with a non-null executor:

1. The child's model selection is the executor selection (instance + model +
   options) instead of the caller's own.
2. Child `runtimeMode` = parent's stored mode; child `interactionMode` =
   `"default"`.
3. The per-parent concurrency cap is the thread's `executorMaxSubAgents`
   instead of the global `DELEGATE_MAX_CHILDREN_PER_PARENT` (the server-wide
   cap still applies).

## Executor sub-agents are pure executors

Delegated children can never delegate further: `delegate_task` refuses any
call from a thread whose `parentThreadId` is set (depth cap 1, enforced
structurally in `DelegateCoordinator`). Executor sub-agents therefore cannot
start sub-agents of their own — they do the work themselves. This is what
keeps advisor fan-out bounded and prevents the delegation loops that broke
the first Advisor/Planner rollout.

## Per-provider behaviour

Steering — getting the model to _act_ like an advisor/planner rather than
merely being permissioned — is per-driver and best-effort.

| Driver                          | Write blocking (from runtime mode)      | Advisor/Planner steering                                                           |
| ------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| Codex, Fugu                     | OS sandbox from runtime mode            | `CODEX_ADVISOR_MODE_DEVELOPER_INSTRUCTIONS`, sent on the `plan` wire mode          |
| Claude, Claudex, ClaudeSynthero | SDK permission mode + `canUseTool` gate | `ExitPlanMode` is denied and the plan artifact suppressed; steer toward delegation |
| Grok (ACP)                      | Per-tool permission requests            | **None** — Grok ignores interaction mode entirely                                  |
| ChatGptBrowser                  | n/a (no tools)                          | None                                                                               |

Codex only accepts `plan | default` as a collaboration mode on the wire, so
advisor borrows the `plan` kind. The advisor developer instructions — which
forbid the `<proposed_plan>` block and describe delegation via `delegate_task` —
are what separate the two.

Grok is the weak spot: without advisor steering it may not _behave_ like an
advisor even when instructed.

## Backend events and permissions

Advisor/Planner reuses the interaction-mode plumbing that plan already uses, plus
one command/event pair for the executor configuration:

- Command: `thread.interaction-mode.set` / Event: `thread.interaction-mode-set`
- Command: `thread.executor-model.set` / Event: `thread.executor-model-set`
- Wire interaction mode is `"advisor"` — a first-class literal since the mode
  was re-introduced (the interim schema that decoded `"advisor"` as `"default"`
  is gone).

Clients that never send `thread.executor-model.set` keep pure consultative
advisor behaviour (executor null → delegation runs on the thread's own model).

## Native control surface (macOS)

The composer's mode capsule:

- **Runtime mode** — always shows and applies the user's chosen workspace access
  (Full Access / Auto-accept Edits / Approvals required), including in
  Advisor/Planner.
- **Interaction mode** — Default / Plan / Advisor/Planner. When Advisor/Planner
  is selected, an **Executor model** row opens the same searchable model
  browser used by the main model picker (including "None — advise only"), and
  a **Max sub-agents** slider (1–10) sets the per-thread executor concurrency
  cap.
- **`/advisor`** is the built-in slash command (wire value `"advisor"`).

## Known gaps

- **Grok does not steer** (above).
- **Executor children are implementers, not advisors.** When an executor is set,
  children run with `interactionMode: "default"` and the stored runtime mode by
  design so they can implement.
- **Claude's advisor steering leans on denying `ExitPlanMode`.** Write access is
  still governed by the thread's runtime mode.
- **Mobile has no advisor UI yet.** The mode decodes everywhere, but the
  executor picker and slider are mac-only for now.
