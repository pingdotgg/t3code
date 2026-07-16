# Runtime modes

A thread carries two independent mode settings. They answer different questions,
and it is worth keeping them apart when reading the code.

| Axis        | Contract                  | Question it answers                           |
| ----------- | ------------------------- | --------------------------------------------- |
| Permission  | `RuntimeMode`             | How much may the agent do without asking?     |
| Interaction | `ProviderInteractionMode` | How should the agent engage with the request? |

Both live on the thread (`OrchestrationThread.runtimeMode` / `.interactionMode`),
are set with `thread.runtime-mode.set` / `thread.interaction-mode.set`, and are
echoed on every `thread.turn.start` so a send can never silently change either.

## Permission axis — `RuntimeMode`

Defined in `packages/contracts/src/orchestration.ts`. Default is `full-access`.

- **`approval-required`** — the strictest mode. Each driver maps it onto its own
  strongest policy: Codex/Fugu get a real `read-only` OS sandbox
  (`approvalPolicy: untrusted`), Claude falls back to the `canUseTool` gate,
  and the Grok ACP driver to per-tool permission requests.
- **`auto-accept-edits`** — Codex/Fugu run `workspace-write` (`danger-full-access`
  inside a git worktree, where `workspace-write` hangs); Claude runs `acceptEdits`.
- **`full-access`** — no approvals. Codex/Fugu run `danger-full-access`; Claude
  runs `bypassPermissions`.

Changing the permission axis restarts the provider session, because most drivers
fix their sandbox at session start.

## Interaction axis — `ProviderInteractionMode`

Default is `default`.

- **`default`** — the agent does the work.
- **`plan`** — the agent explores and proposes a plan, which the client renders
  as a plan card. It does not implement. This is prompt-level only: plan mode
  does **not** change the sandbox, so a `full-access` plan thread can still
  write if the model ignores its instructions.
- **`advisor`** — Advisor/Planner: the agent answers, explains, reviews,
  recommends, and is steered to prefer advising over editing. When a per-thread
  executor model is configured, it may delegate implementation to sub-agents
  that inherit the thread's stored runtime mode. Permissions are not forced —
  Full Access and Auto-accept Edits remain available. See
  [advisor-mode.md](./advisor-mode.md).

## Where the two axes meet

The two axes are independent. Interaction mode never rewrites the permission
axis: `ProviderCommandReactor` starts the provider session with the thread's
stored `runtimeMode` for every interaction mode. Sub-agents always inherit that
same stored mode. Advisor "don't edit yourself" behaviour is prompt-level
guidance only.
