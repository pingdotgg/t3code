# Sub-agent guardrails: model policy, spawn limits, command-row styling

Branch: `sergecode/25dc188c` (already checked out in this worktree). Do NOT touch
`apps/mac/version.json`. All work lands as PR-sized commits on this branch.

## Problem

1. Sub-agents spawned via the `agent_*` MCP toolkit have **no model/effort policy**:
   children inherit or request expensive models (`gpt-5.6-sol`, `claudex-sol`,
   `claude-fable-5`) at `max` reasoning, and outdated models (`gpt-5.4`, `gpt-5.5`)
   get picked because `DEFAULT_MODEL` is still `gpt-5.4`.
2. The live spawn path (`SubAgentCoordinator`) has **no concurrency or rate limits** —
   only a depth-2 check. A child can burst-spawn many expensive siblings. (The
   limit machinery in `apps/server/src/subagent/ConcurrencyLimits.ts` belongs to a
   second, unused subsystem and is NOT wired into this path.)
3. Mac app: `local_bash` background tasks render with sub-agent styling/icon in the
   chat timeline because the client never decodes the server's `entityType`
   ("command" vs "subagent") on task activities.

## Decided policy (user-confirmed — do not weaken or renegotiate)

**Banned as sub-agent models (parent/main threads only):**
`claude-fable-5`, `claudex-sol`, `gpt-5.6-sol`, and all outdated codex gens
(`gpt-5.4`, `gpt-5.5`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5-codex`, any non-5.6 gpt).

**Allowed sub-agent models + effort caps:**
| model | effort cap | default effort |
|---|---|---|
| `claudex-luna` | xhigh (never max/ultracode) | **xhigh** |
| `gpt-5.6-luna` | xhigh | **xhigh** |
| `gpt-5.6` (base), `gpt-5.6-terra` | high | provider default clamped to high |
| `claude-sonnet-5` | high | clamped to high |
| `claude-opus-4-8` | high | clamped to high |
| grok / fugu / chatgpt models | high | clamped to high |

Luna-class models (`claudex-luna`, `gpt-5.6-luna`) are cheap → xhigh. Everything
else caps at high. **No sub-agent ever runs max/ultracode.**

**Clamp map (enforcement = clamp + notice, never hard-fail on model).**
IMPORTANT: key the policy on **model slug first**, not driver kind — the live
`claudex` provider instance runs the `claudeAgent` driver but serves
`claudex-luna`/`claudex-sol`/`gpt-5.6-terra` slugs, so driver-keyed tables would
miss them. Driver is only the fallback for unknown slugs.

- `claudex-sol` → `claudex-luna`
- `gpt-5.6-sol` → `gpt-5.6-luna`
- outdated codex slugs (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`,
  `gpt-5.3-codex-spark`, `gpt-5.2`, `gpt-5-codex`) → `gpt-5.6-luna`
  (live codex catalog has NO bare `gpt-5.6`; luna is the cheap allowed 5.6)
- `claude-fable-5` → `claude-opus-4-8`; `claude-opus-4-7`/`4-6`/`4-5` → `claude-opus-4-8`
- `claude-haiku-4-5`, `claude-sonnet-4-6` → `claude-sonnet-5`
- Unknown slug fallback by prefix/driver: `claudex-*` → `claudex-luna`;
  `claude-*` → `claude-sonnet-5`; codex driver → `gpt-5.6-luna`; anything else
  (grok/fugu/chatgpt) passes through with effort cap high.
- If a clamp replacement is not present in the target provider's live model
  catalog, fall back to the first allowed model that IS present; if none, pass
  the original through (catalogs are advisory) — but still clamp effort and emit
  a notice.
- Effort above cap → clamped to cap. Every clamp produces a human-readable notice
  string (e.g. `model claudex-sol → claudex-luna (banned for sub-agents)`,
  `effort max → xhigh (sub-agent cap)`).

**Structural limits (reject with error, not clamp):**

- Depth: keep existing `SUB_AGENT_MAX_SPAWN_DEPTH = 2`.
- Max **5 running children per caller** thread.
- Max **10 running sub-agents per root tree** (walk parent chain in the in-memory
  children map to find the root).
- Rate limit: max **3 spawns per caller thread per 60s** sliding window.

**Executor-mode spawns are NOT exempt:** when Advisor/Planner executor selection is
authoritative (`SubAgentCoordinator.ts:693-726`), the policy clamps the executor's
model/effort the same way, with a notice.

## Phase 1 — server (TypeScript)

### 1a. `packages/contracts/src/subAgents.ts` (schema-only package — constants + schemas only)

- Add constants next to `SUB_AGENT_MAX_SPAWN_DEPTH` (line 25):
  `SUB_AGENT_MAX_RUNNING_CHILDREN_PER_AGENT = 5`,
  `SUB_AGENT_MAX_RUNNING_PER_ROOT = 10`,
  `SUB_AGENT_SPAWN_RATE_LIMIT = { max: 3, windowMillis: 60_000 } as const`.
- Add `"rate-limit-exceeded"` to `SubAgentErrorReason` (line 176).
- `SubAgentSpawnResult` (line 125): add
  `policyNotices: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([])))`
  (follow the `SubAgentListResult.agents` pattern at line 92 for decoding default).

### 1b. `apps/server/src/orchestration/subAgentModelPolicy.ts`

Extend this module (it already hosts `enforceSubAgentStandardMode`) with a pure,
unit-testable policy:

- `EFFORT_RANK`: `minimal < low < medium < high < xhigh < max < ultracode`.
- **Slug-keyed** clamp table implementing the map above (driver/prefix only as
  unknown-slug fallback). Luna-class set: `{ "claudex-luna", "gpt-5.6-luna" }` →
  cap/default `xhigh`; everything else → cap `high`.
- `applySubAgentModelPolicy(args: { driver: ProviderDriverKind; model: string; availableModels: ReadonlyArray<string>; selection: ModelSelection; capabilities?: ModelCapabilities }) => { model: string; selection: ModelSelection; notices: ReadonlyArray<string> }`
  (`availableModels` = the target provider's live catalog slugs, for the
  replacement-availability fallback.)
  - Clamps the model slug per the map (drivers without a table pass through).
  - Clamps/sets the effort option on `selection.options`: find the effort
    descriptor (option ids `effort` / `reasoningEffort` / `reasoning` — reuse the
    approach of `resolveSpawnEffort` in `SubAgentCoordinator.ts:193-214` via
    `getProviderOptionDescriptors`). If the current/default value ranks above the
    cap, replace it with the highest descriptor value ranked ≤ cap (fall back to
    the cap literal if descriptor values are unknown). For luna-class models with
    no explicit effort, set `effort: "xhigh"` explicitly.
  - Composes with `enforceSubAgentStandardMode` (still strip fastMode/serviceTier).
- Check `enforceSubAgentStandardMode` call sites (there is a second enforcement at
  the orchestration boundary). If the boundary has access to the provider driver
  kind (via registry or the thread's modelSelection instanceId), apply
  `applySubAgentModelPolicy` there too so a per-turn model selection on a child
  thread can't re-escalate effort. If driver kind is not reachable there, clamp
  effort by slug class only (slug is in the selection) and document why.

### 1c. `apps/server/src/mcp/toolkits/agents/SubAgentCoordinator.ts`

In `spawn` (line 669):

- **Rate limit** (before provider resolution): keep
  `SynchronizedRef<Map<ThreadId, ReadonlyArray<number>>>` of spawn timestamps per
  caller; use `Clock.currentTimeMillis` (Clock is already imported). Prune to the
  60s window; if count ≥ 3 → `SubAgentError` reason `"rate-limit-exceeded"`,
  description tells the caller how many seconds to wait and to consolidate work
  into fewer, larger sub-agent tasks. Record the timestamp only after a spawn
  actually dispatches (don't burn the budget on validation failures).
- **Running-children cap**: count caller's children in the map with
  `status === "running"`, refreshing non-terminal records best-effort first (same
  pattern `list` uses at lines 619-642 — extract a small helper instead of
  duplicating). If ≥ 5 → `SubAgentError` `"concurrency-limit-exceeded"` telling the
  caller to `agent_wait` for running children first.
- **Root-tree cap**: ascend `parentThreadId` links through the children map from
  the caller to the root, then count all running records whose ancestry reaches
  that root. If ≥ 10 → `"concurrency-limit-exceeded"` (message: tree-wide cap).
- **Model/effort policy**: after the `model` const resolves (line 723-726) and
  `resolveSpawnModelSelection` (line 745), run `applySubAgentModelPolicy` with the
  target driver + capabilities. Use the clamped model/selection everywhere
  downstream (thread.create, record, result, activity). Executor path included.
- Surface `notices` in: the spawn result (`policyNotices`), and
  `emitSpawnStartedActivity` text so the parent's agent log shows the clamp.
- The MCP tool result text for `agent_spawn` (see `handlers.ts` /
  `tools.ts:32`) should include the notices so the calling model learns the rules.
- Update the `agent_spawn` tool description (`tools.ts:34`) to state the policy:
  banned models, caps, defaults, limits — so agents pick allowed models up front.

### 1d. `packages/contracts/src/model.ts`

- `DEFAULT_MODEL` (line 138): `"gpt-5.4"` → `"gpt-5.6"`. Leave
  `DEFAULT_GIT_TEXT_GENERATION_MODEL` alone. Fix any tests/fixtures that assert
  the old default.

### 1e. `apps/server/src/subagent/SubAgentProviderInfo.ts` (consistency only)

Refresh `MODEL_COST_TIERS` with current slugs: `gpt-5.6-luna` + `claudex-luna`
cheap; `gpt-5.6`, `gpt-5.6-terra` moderate; `gpt-5.6-sol`, `claudex-sol`,
`claude-fable-5`, `claude-opus-4-8` expensive. Keep existing entries.

### 1f. Tests

- Locate existing tests for the coordinator/policy (search `apps/server` for
  SubAgentCoordinator / subAgentModelPolicy test files; follow local conventions,
  it.effect where used).
- Unit-test the clamp matrix in `subAgentModelPolicy`: every banned model maps
  correctly, effort above cap clamps, luna default xhigh, notices generated,
  allowed models untouched, standard-mode stripping still applies.
- Coordinator tests: rate limit trips on 4th spawn in window; children cap at 5;
  root cap at 10 across a depth-2 tree; executor selection gets clamped;
  spawn result carries notices.
- Gate: `vp check` and `vp run typecheck` must pass.

Commit Phase 1 as one or two commits (contracts vs server split is fine).

## Phase 2 — mac app (Swift)

Read `apps/mac/CLAUDE.md` first (no `@State` — use `@UIState`; strict concurrency;
build/test commands are in there).

Server already classifies tasks: `ClaudeAdapter.taskEntityType`
(`apps/server/src/provider/Layers/ClaudeAdapter.ts:841-853`) emits
`entityType: "command" | "subagent" | ...` on `task.started/progress/completed`
activities; raw `taskType` (e.g. `local_bash`) also present. The mac client drops
`entityType` entirely.

- `apps/mac/Sources/T3Kit/ActivityPayloads.swift`: add `entityType: String?` to
  `TaskStartedActivityPayload` (line 241) and the progress/completed payloads the
  server emits it on.
- `apps/mac/Sources/T3Kit/SubagentTaskActivityState.swift`: thread an
  entity-kind through to `SubagentTaskItem` (e.g. enum `command` / `subagent` /
  `workflow`, default `subagent`). Fallback heuristic when `entityType` is absent
  (older persisted activities): `taskType` in
  `{local_bash, bash, command, command_execution}` → `command`.
- UI (`apps/mac/Sources/SergeCodeMac/UI/Chat/ChatTimelineRow.swift:144-159`,
  `SubagentTaskComponents.swift`): command-kind tasks must stop presenting as
  sub-agents in the chat/agent log:
  - Leading glyph: terminal symbol (`apple.terminal` or `terminal`) instead of the
    agent glyph; keep the state icons (`SubagentTaskStatusIcon`) as-is.
  - Fallback title `"Command"` instead of `"Subagent task"`
    (`SubagentTaskComponents.swift:52-56`).
  - Keep identity badge, rail, tint behavior; goal is visual distinction, not a
    new row type.
- Sidebar is already correct (commands never appear there) — do not touch sidebar
  nesting logic from PR #153.
- Extend the existing SubagentTaskActivityState tests for the kind mapping +
  fallback heuristic. Build with
  `swift build --package-path apps/mac`; run the mac tests with the exact
  `swift test` incantation from `apps/mac/CLAUDE.md`.

Commit Phase 2 separately.

## Non-goals

- Do not wire up or delete the second subsystem (`apps/server/src/subagent/`
  UniversalSubAgentCoordinator) beyond the cost-tier refresh in 1e.
- No persistence for spawn bookkeeping (in-memory map stays; restart resets are
  accepted and documented in the coordinator header).
- No changes to parent-thread (user-facing) model pickers — parents may still run
  fable-5 / sol / max effort. Policy applies only to spawned sub-agent threads.
