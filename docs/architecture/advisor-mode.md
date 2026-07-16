# Advisor/Planner mode

Advisor/Planner is a consultative thread mode: the agent reads the workspace,
answers questions, explains how things work, reviews code and designs, weighs
tradeoffs and recommends a course of action — preferring not to change the
workspace itself while it does so. When the user configures a per-thread
**executor model**, the agent can also plan work and **delegate implementation
to executor sub-agents** that inherit the thread's stored runtime mode (write
access depends on that mode).

It is the third value on the interaction axis (`default | plan | advisor`); the
wire literal remains `"advisor"`. See [runtime-modes.md](./runtime-modes.md) for
how that axis relates to permissions.

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
edit. With an executor model configured, it may spawn sub-agents that implement
under the thread's stored runtime mode.

## Permissions are independent

Interaction mode (normal / plan / advisor) is fully independent of runtime
permission mode. The user can run Advisor/Planner with Full Access, Auto-accept
Edits, or Approvals required. There is no permission clamp on advisor turns.

"Don't edit files yourself" is **prompt-level guidance** (developer instructions
and steering). Actual write access is purely the user's runtime-mode choice.

Invariants:

- The session uses the thread's stored `runtimeMode` for every interaction mode.
- **Sub-agents always inherit the parent thread's stored runtimeMode**, with or
  without an executor model.
- **With an executor model**, `SubAgentCoordinator` spawns children on that
  instance/model with `interactionMode: "default"`. This is an explicit
  user-opted-in path for delegated implementation.

## Executor model selection

Thread field: `executorModelSelection: ModelSelection | null` on the thread read
model and shell.

- Command: `thread.executor-model.set` with `{ executorModelSelection }` (`null`
  clears → advise only).
- Event: `thread.executor-model-set`.
- Persisted as `projection_threads.executor_model_selection` (nullable JSON).
- Not carried per-turn; read at spawn time from the parent thread projection.

When spawning from an advisor parent with a non-null executor:

1. Provider comes from `executor.instanceId` (overrides the tool's
   `providerInstanceId`).
2. Model is always `executor.model` verbatim (provider catalogs are advisory;
   a stale slug surfaces as a provider session-start error).
3. Child `runtimeMode` = parent's stored mode.
4. If the executor provider is not spawnable → hard `SubAgentError` (no silent
   fallback).

When the executor is null, or the parent is not advisor, spawn behaviour is
unchanged except that children still inherit the parent's stored runtime mode.

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
forbid the `<proposed_plan>` block and describe delegation — are what separate
the two.

Grok is the weak spot: without advisor steering it may not _behave_ like an
advisor even when instructed.

## Backend events and permissions

Advisor/Planner reuses the interaction-mode plumbing that plan already uses, plus
one new command/event pair for the executor model:

- Command: `thread.interaction-mode.set` / Event: `thread.interaction-mode-set`
- Command: `thread.executor-model.set` / Event: `thread.executor-model-set`
- Wire interaction mode stays `"advisor"` — no schema widening of the mode
  literal, no data migration for interaction mode.

Old clients that never send `thread.executor-model.set` keep pure consultative
advisor behaviour (executor null → no specific executor binding on spawns).

## Native control surface (macOS)

The composer's mode capsule:

- **Runtime mode** — always shows and applies the user's chosen workspace access
  (Full Access / Auto-accept Edits / Approvals required), including in
  Advisor/Planner.
- **Interaction mode** — Default / Plan / Advisor/Planner. When Advisor/Planner
  is selected, an **Executor model** summary row opens the same searchable model
  browser used by the main model picker (including "None — advise only").
- **`/advisor`** remains the built-in slash command (wire value unchanged).

## Known gaps

- **Grok does not steer** (above).
- **Executor children are implementers, not advisors.** When an executor is set,
  children run with `interactionMode: "default"` and the stored runtime mode by
  design so they can implement.
- **Claude's advisor steering leans on denying `ExitPlanMode`.** Write access is
  still governed by the thread's runtime mode.
