# Advisor/Planner mode

Advisor/Planner is a consultative thread mode: the agent reads the workspace,
answers questions, explains how things work, reviews code and designs, weighs
tradeoffs and recommends a course of action — and cannot change the workspace
itself while it does so. When the user configures a per-thread **executor
model**, the agent can also plan work and **delegate implementation to
executor sub-agents** that inherit the thread's stored runtime mode (not the
advisor clamp; actual write access depends on that mode).

It is the third value on the interaction axis (`default | plan | advisor`); the
wire literal remains `"advisor"`. See [runtime-modes.md](./runtime-modes.md) for
how that axis relates to permissions.

## Advisor/Planner vs. plan

They look similar and are easy to conflate, so the distinction is worth stating
plainly.

|             | Plan                                                  | Advisor/Planner                                                            |
| ----------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| Goal        | A decision-complete spec another agent can implement  | An answer, a plan of action, and optionally delegated implementation       |
| Output      | A `<proposed_plan>` artifact, rendered as a plan card | An ordinary chat reply (and optional sub-agent results)                    |
| Ends when   | You accept the plan and implement it                  | You stop asking                                                            |
| Enforcement | Prompt-level only — the sandbox is unchanged          | Sandbox/permission-level — the parent cannot write; executors may when set |

Plan mode is a phase of doing the work that produces a handoff artifact.
Advisor/Planner is consultative: the parent never mutates the workspace. With an
executor model configured, it may spawn sub-agents that implement under the
thread's stored runtime mode.

## Enforcement

Advisor/Planner does not trust the model to honour a prompt.
`resolveEffectiveRuntimeMode` (`packages/contracts/src/orchestration.ts`) clamps
the permission axis for the parent session:

```text
advisor + any RuntimeMode  ->  approval-required
```

`ProviderCommandReactor.ensureSessionForThread` starts the provider session with
that effective mode, so an advisor thread runs under whatever the driver already
considers its strictest policy. Advisor/Planner **fails closed** for the parent.

Invariants:

- The thread keeps the user's stored `runtimeMode`; only the parent session is
  clamped. Leaving advisor restores what they picked.
- The restart-on-change check compares the _effective_ mode against the session's
  mode.
- **Sub-agents without an executor model inherit the clamped mode**, not the
  stored one. This preserves the historical "delegation is not an escape hatch"
  invariant when the user has not opted into an executor.
- **Sub-agents with an executor model are the deliberate exception.** When
  `executorModelSelection` is set on an advisor thread, `SubAgentCoordinator`
  spawns children on that instance/model with the parent's _stored_ (unclamped)
  `runtimeMode` and `interactionMode: "default"`. This is an explicit
  user-opted-in write path for delegated implementation.

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
3. Child `runtimeMode` = parent's stored mode (unclamped).
4. If the executor provider is not spawnable → hard `SubAgentError` (no silent
   clamped fallback).

When the executor is null, or the parent is not advisor, spawn behaviour is
unchanged from the original advisor clamp.

## Per-provider behaviour

Enforcement is uniform (the parent clamp). Steering — getting the model to _act_
like an advisor/planner rather than merely being unable to write — is per-driver
and best-effort.

| Driver                          | Write blocking (from the clamp)                | Advisor/Planner steering                                                           |
| ------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Codex, Fugu                     | `read-only` OS sandbox — a real one            | `CODEX_ADVISOR_MODE_DEVELOPER_INSTRUCTIONS`, sent on the `plan` wire mode          |
| Claude, Claudex, ClaudeSynthero | SDK `plan` permission mode + `canUseTool` gate | `ExitPlanMode` is denied and the plan artifact suppressed; steer toward delegation |
| Grok (ACP)                      | Per-tool permission requests                   | **None** — Grok ignores interaction mode entirely                                  |
| ChatGptBrowser                  | n/a (no tools)                                 | None                                                                               |

Codex only accepts `plan | default` as a collaboration mode on the wire, so
advisor borrows the `plan` kind. The advisor developer instructions — which
forbid the `<proposed_plan>` block and describe delegation — are what separate
the two.

Grok is the weak spot. It gets the permission clamp, so it cannot write without
asking, but it will not _behave_ like an advisor.

## Backend events and permissions

Advisor/Planner reuses the interaction-mode plumbing that plan already uses, plus
one new command/event pair for the executor model:

- Command: `thread.interaction-mode.set` / Event: `thread.interaction-mode-set`
- Command: `thread.executor-model.set` / Event: `thread.executor-model-set`
- Parent clamp still uses existing `RuntimeMode` values rather than a new
  permission level.
- Wire interaction mode stays `"advisor"` — no schema widening of the mode
  literal, no data migration for interaction mode.

Old clients that never send `thread.executor-model.set` keep pure consultative
advisor behaviour (executor null → clamped sub-agents).

## Native control surface (macOS)

The composer's mode capsule:

- **Runtime mode** — label shows the mode actually in force. Under
  Advisor/Planner it reads "Approvals required" with copy explaining the parent
  clamp (and that executor sub-agents use the stored mode when configured).
- **Interaction mode** — Default / Plan / Advisor/Planner. When Advisor/Planner
  is selected, an **Executor model** section offers "None — advise only" plus
  one row per available model (slug granularity only).
- **`/advisor`** remains the built-in slash command (wire value unchanged).

## Known gaps

- **Grok does not steer** (above). It is safe, not useful.
- **Executor children are implementers, not advisors.** When an executor is set,
  children run with `interactionMode: "default"` and the stored runtime mode by
  design so they can implement. Without an executor, children remain
  permission-clamped but still spawn as default interaction mode (they try to
  work and raise approvals).
- **Entering advisor does not restart a live session eagerly.** The clamp is
  applied at the next `ensureSessionForThread`. No turn ever runs unclamped;
  only the idle session lags.
- **Claude's advisor steering leans on denying `ExitPlanMode`.** Write-blocking
  is unaffected either way.
