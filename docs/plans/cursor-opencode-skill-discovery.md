# Cursor + OpenCode Skill Discovery — Development Plan

> **Status (2026-07-22):** **Phase 1 Cursor FS list + apply — DONE** on `feat/cursor-fs-skill-discovery` (tip `82c445ede`).  
> Snapshot `$` skills from `.cursor/skills` + `~/.cursor/skills`; send-path injects matched SKILL.md bodies under Cursor ACP. Hardened (symlink containment, `$` mention boundary, 64KiB body cap).
>
> **Residuals (not blocking ship):**
>
> - **Per-thread / per-worktree `$` menu** — provider snapshot remains process-wide (`ServerConfig.cwd`); send-apply already merges session cwd + server cwd so listed skills still inject when roots diverge. True per-thread menu listing is a follow-up.
> - **OpenCode `$`** — deferred until human unblocks.
> - **Cursor ACP `/` (slashCommands)** — deferred follow-up after FS `$`.
>
> Nested Task model allowlist: only `composer-2.5-fast` or `cursor-grok-4.5-high-fast`. Solo agents: **Cursor only** (`agent_tool_id: 8`).

---

## TL;DR (paste into Solo agent first prompt)

```text
You are implementing Cursor filesystem $ skill discovery in the t3code fork at /Users/blaqat/dev/forks/t3code.

Read the full plan first:
  docs/plans/cursor-opencode-skill-discovery.md

Priority (user-locked):
- Cursor first. OpenCode phases are deferred — do not start OpenCode work unless the human explicitly unblocks it.
- Filesystem Cursor skills → provider snapshot.skills → composer $ menu. ACP slash commands are a later follow-up.
- Solo agents: ONLY Cursor (agent_tool_id: 8, project_id: 5). Nested Task models: ONLY composer-2.5-fast or cursor-grok-4.5-high-fast (set explicitly).

Ground truth:
- Web/mobile $ and / menus read ONLY selectedProviderStatus.skills / .slashCommands from the provider snapshot (not live RPC).
- Selecting a $ skill only inserts `$skillName ` into the composer. Send passes that text through unchanged (no T3-side skill expansion).
- Codex already interprets `$name` in the prompt → listing + insert is enough for Codex.
- CursorAdapter sends plain text via ACP session/prompt. Native Cursor invokes skills with `/name` (and/or auto-apply). Cursor v1 must verify that selecting a skill is useful on send — not only that it lists.
- Prefer snapshot population first (smallest PR). Do NOT blindly merge upstream PRs #3154/#3787/#3788/#4031/#3982/#3059 — cherry-pick ideas only.
- Verify with Solo processes :typecheck and :test (and focused vitest where noted).
- Implement ONE phase at a time. Stop at phase acceptance criteria and report what changed.

Start with Phase 0 only unless the human says otherwise.
```

---

## 1. Problem statement

In T3 Code, the composer `$` (skills) and `/` (slash commands) menus are driven exclusively by the **selected provider’s snapshot fields**:

| Trigger | Snapshot field                         | Codex today                 | Claude today                     | Cursor today    | OpenCode today  |
| ------- | -------------------------------------- | --------------------------- | -------------------------------- | --------------- | --------------- |
| `$`     | `selectedProviderStatus.skills`        | populated via `skills/list` | empty                            | **always `[]`** | **always `[]`** |
| `/`     | `selectedProviderStatus.slashCommands` | empty / N/A                 | populated from init/capabilities | **always `[]`** | **always `[]`** |

**User-facing symptom:** With Cursor selected, typing `$` shows empty-state copy (“No skills found…”) even when Cursor skills exist on disk (e.g. `.cursor/skills/**/SKILL.md`). OpenCode has the same empty-snapshot hole, but **OpenCode work is deferred** until Cursor FS `$` lands.

**Architectural constraint (do not fight it in v1):**  
`ChatComposer.tsx` / `ThreadComposer.tsx` / `providerSkillSearch.ts` do **not** call a live `listSkills` RPC on main. They map the snapshot arrays. Empty arrays → empty menus.

**Root causes:**

1. **Cursor (v1 focus):** `CursorProvider` / `CursorDriver` never pass `skills` or `slashCommands` into `buildServerProvider`. There is no `.cursor/skills` (or equivalent) scanner. Upstream ACP slash-command work (#3787/#3788/#3757) still leaves `skills: []`.
2. **OpenCode (deferred):** Inventory is `{ providerList, agents }` only (`opencodeRuntime.ts` → `loadOpenCodeInventory` / `loadInventoryFromCli`). `app.skills()` is unused on the SDK path; the local CLI inventory path has no skills command/parsing at all. Upstream #3154 maps SDK skills only.

### What selecting a `$` skill does today (listing vs send)

Plain language:

1. **Menu / select (UI only):** Typing `$` searches `selectedProviderStatus.skills`. Choosing an item replaces the `$…` token with the literal text `` `$skillName ` `` in the composer (`ChatComposer.tsx` skill branch → `` `$${item.skill.name} ` ``). Nothing is loaded from disk at select time.
2. **Send (no T3 expansion):** On submit, that composer string is sent as the turn `input` unchanged. Neither Codex nor Cursor adapters rewrite `$name` into SKILL.md body in this fork.
3. **Codex:** Enough for real use. Codex app-server / runtime interprets `$name` after receive, so **menu insert + provider interpretation** is the full Codex path. No extra T3 “runtime loader” is required for Codex.
4. **Cursor:** Not automatically enough. `CursorAdapter.sendTurn` forwards plain text via ACP `session/prompt`. Native Cursor docs invoke skills with `/skill-name` (and/or auto-apply from discovered skills). T3 does **not** currently expand or remap `$name` for Cursor. So “it lists and I can select it” only guarantees the text `$skillName ` is in the message — **not** that Cursor applied the skill.

**Cursor v1 implication:** Snapshot listing is necessary but not sufficient. Cursor Phase 1 acceptance must include a short send-path check (see Phase 1): confirm whether `$name`, `/name`, or another insert form causes the Cursor ACP agent to load/apply the skill; if `$name` is inert, fix insert format or document/implement the minimal send-path behavior before calling Cursor `$` done.

---

## 2. Goals / non-goals

### Goals

1. **Cursor (first):** Users see filesystem-discovered Cursor skills in `$` when Cursor is the selected provider.
2. **Cursor (first):** Selecting a listed skill is useful on send — not a dead `$name` token. Resolve insert/send behavior as part of Cursor v1 acceptance (see Phase 1).
3. Keep the existing composer UX: snapshot → `searchProviderSkills` — no mandatory live RPC for v1 menus.
4. Align contracts with `ServerProviderSkill` / `ServerProviderSlashCommand` in `packages/contracts/src/server.ts`.
5. Ship as **small, reviewable PR slices** executable by **Cursor-only** Solo agents (`agent_tool_id: 8`) with `:typecheck` / `:test` gates.
6. **OpenCode (deferred):** Later, populate OpenCode skills into `$` for SDK and local CLI paths — only after Cursor FS `$` ships, when the human unblocks OpenCode phases.

### Non-goals (v1)

- OpenCode skill discovery (deferred; keep Phase 0 baseline only).
- Cursor ACP `available_commands` → `/` (follow-up after FS `$`).
- Full merge of upstream PRs (#3154, #3787, #3788, #4031, #3982, #3059) — learn/cherry-pick only.
- Replacing Codex `skills/list` or Claude slash-command plumbing.
- Building a generic cross-provider skill marketplace UI.
- Live FS watchers / `skills/changed`-style push invalidation (nice-to-have; later scoping phase).
- Mobile-only UX redesign (mobile should work if snapshot is filled; no separate mobile discovery path).
- Guaranteeing Cursor ACP `available_commands_update` session-time updates land in the **provider status** snapshot without a clear design (session events ≠ provider probe).
- Spawning non-Cursor Solo agents (Claude / OpenCode / Codex) for implementation.

### Locked product decisions

| Decision           | Choice                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Priority           | **Cursor first**; OpenCode deferred                                                              |
| Cursor `$` source  | **Filesystem** skill dirs (`.cursor/skills`, user skills roots as confirmed in Phase 1 research) |
| Cursor `/` (ACP)   | **Follow-up** — not required for Cursor FS `$` v1                                                |
| Semantic model     | Option A long-term: FS skills → `$`; ACP available commands → `/` later                          |
| Solo execution     | **Cursor agent only** (`agent_tool_id: 8`, `project_id: 5`)                                      |
| Nested Task models | Only `composer-2.5-fast` or `cursor-grok-4.5-high-fast`                                          |

**OpenCode default (when unblocked later):** Skills → `$` only (no Claude-style slash inventory in current fork).

---

## 3. Recommended approach (with tradeoffs)

### Recommendation: **Cursor FS snapshot first**, then verify send usefulness; OpenCode later

**v1 shape (Cursor)**

1. Add a Cursor skill discovery module (FS scan of known Cursor skill roots), map into `skills` on `buildServerProvider`.
2. Leave `slashCommands: []` for Cursor until the ACP `/` follow-up.
3. Confirm select → send behavior for Cursor (Codex-style `$name` vs Cursor-native `/name` vs content injection). Ship the minimal fix if `$name` is inert under ACP.
4. Defer OpenCode inventory skills, ACP slash bridging, and workspace RPC until Cursor FS `$` is accepted.

### Why snapshot-first

| Approach                                 | Pros                                                                                                             | Cons                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Snapshot-only menus (recommended)**    | Matches current UI; smallest change surface; easy to test with fixture inventories; no web/mobile contract churn | Stale until provider re-probe; cwd/workspace switches may need a later phase                           |
| **projectCapabilities / listSkills RPC** | Fresher, cwd-aware, closer to #3787                                                                              | Larger contract + web/mobile work; still need a server inventory source; overkill until snapshot works |
| **Blind merge of open PRs**              | Faster looking                                                                                                   | Incomplete (OpenCode CLI hole; Cursor skills still `[]`); merge conflict risk on fork                  |

### Reuse vs rewrite from open PRs

| PR                                                           | Steal                                                                           | Do not blindly take                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **#3787 / #3788** Local Skills + slash / projectCapabilities | Cwd scoping ideas; slash-command snapshot shape; capability probe patterns      | Full projectCapabilities stack before snapshot works; leaving `skills: []` for Cursor; ACP `/` before FS `$` |
| **#4031 / #3982 / #3059** workspace-scoped Codex/Grok skills | Scope field / cwd filtering conventions                                         | Codex-specific app-server RPC as Cursor solution                                                             |
| **#3154** OpenCode skill discovery                           | SDK `app.skills()` mapping → `ServerProviderSkill` (when OpenCode is unblocked) | Assuming CLI path is fixed; starting OpenCode before Cursor                                                  |

---

## 4. Phased implementation (PR-sized slices)

### Phase 0 — Repro / prove empty snapshot (Cursor-first evidence)

**Intent:** Lock the bug with evidence so later phases have a regression baseline. Emphasize Cursor; keep a light OpenCode empty-array assertion for when OpenCode is unblocked.

**Work**

1. Confirm UI path: `ChatComposer.tsx` uses `selectedProviderStatus?.skills` / `.slashCommands`; empty → empty-state string.
2. Confirm select path: skill menu item inserts `` `$skillName ` `` only (no disk read / no expansion).
3. Confirm send path: Cursor `sendTurn` passes trimmed prompt text to ACP; no skill rewrite.
4. Confirm server path: Cursor `buildServerProvider` calls omit `skills`/`slashCommands` (default `[]` in `providerSnapshot.ts`).
5. Add or extend a focused test that Cursor provider draft has `skills: []` and `slashCommands: []` when enabled/installed (current behavior).
6. Optionally keep/assert OpenCode `skills: []` after inventory load (baseline only; do not implement OpenCode discovery).
7. Document manual repro steps for Solo QA (Cursor selected + `$` primary).

**Acceptance criteria**

- [ ] Written repro steps in this plan’s Phase 0 notes (or PR description) that a human can follow in ~2 minutes (Cursor `$` empty).
- [ ] Automated assertion(s) capturing **today’s empty Cursor arrays** (will be inverted/updated in Phase 1).
- [ ] Short note in Phase 0 output confirming select inserts `$name` and Cursor send does not expand skills.
- [ ] `:typecheck` green; no product behavior change required.

**Estimated file touch list**

- `apps/server/src/provider/Layers/CursorProvider.ts` (read-only / test hooks)
- Possibly new/extend: `apps/server/src/provider/Layers/CursorProvider.test.ts`
- `apps/web/src/components/chat/ChatComposer.tsx` (read-only confirmation)
- `apps/server/src/provider/Layers/CursorAdapter.ts` (read-only send-path confirmation)
- Optional baseline: `OpenCodeProvider.test.ts`
- This plan file (optional Phase 0 notes)

---

### Phase 1 — Cursor FS skills into snapshot + send-path acceptance

**Intent:** First user-visible win for the primary provider. Fill `$` from disk, then prove select→send is useful for Cursor (not listing-only theater).

**Work — 1a Discover (FS)**

1. Spike and record skill roots Cursor actually uses:
   - Project: `.cursor/skills/**/SKILL.md`
   - User: `~/.cursor/skills/**` (confirm layout)
   - Agents-compatible paths only if Cursor actually reads them — don’t invent
2. Add `cursorSkillDiscovery.ts` (name flexible) with pure scan/parse helpers (SKILL.md frontmatter → `ServerProviderSkill`).
3. Call from `CursorProvider` refresh/probe path; pass `skills` into `buildServerProvider`.
4. Soft-fail: missing dirs → `[]`; parse errors skip file, don’t fail provider.
5. Explicitly leave `slashCommands: []` (ACP `/` is a follow-up).
6. Unit tests with temp dirs / fixtures.

**Work — 1b Send-path / invocation (Cursor v1 gate)**

1. Manual or scripted check with Cursor ACP: after selecting a skill from `$`, does the agent actually apply it?
2. Compare insert forms if needed:
   - Current UI: `$skillName ` (Codex-aligned)
   - Cursor-native docs: `/skillName`
   - Fallback only if required: inject/attach skill content on send (prefer not; larger change)
3. If `$name` is inert under Cursor ACP, implement the **smallest** fix so select→send is useful (likely provider-aware insert text, or mapping Cursor skills into a form Cursor honors). Do not ship listing-only if select is known-useless.
4. Document the chosen behavior in the PR description.

**Acceptance criteria**

- [x] With fixture skills on disk, Cursor snapshot `skills` non-empty.
- [x] Composer `$` search returns those skills (web; mobile inherits snapshot).
- [x] **Send-path:** Selecting a listed Cursor skill and submitting applies/uses the skill usefully (or the PR documents a verified Cursor-native mechanism that makes the inserted token work). Listing alone is not enough for Phase 1 done.
- [x] No regression to Cursor model discovery / ACP model picker.
- [x] `slashCommands` still empty unless a tiny incidental change is required for the send-path fix.
- [x] `:typecheck` + Cursor discovery unit tests green.

**Shipped (Phase 1 DONE):** discover + apply (`7173f10a3`), ServerConfig.cwd listing (`95e17c1c7`), send-apply merge session+server cwd (`44c3e9ad4`), P1/P2/P3 harden (`82c445ede`).

**Estimated file touch list**

- `apps/server/src/provider/Layers/CursorProvider.ts`
- `apps/server/src/provider/Drivers/CursorDriver.ts` (only if needed)
- New: `apps/server/src/provider/cursorSkillDiscovery.ts` (+ `.test.ts`)
- Possibly `apps/web/src/components/chat/ChatComposer.tsx` if Cursor needs provider-aware insert text
- `packages/effect-acp` — **read-only** unless a typed client call is required

---

### Phase 2 — Wire `$` semantics for Cursor; keep ACP `/` deferred

**Intent:** Make menus match the locked model without pulling ACP slash into v1.

**Work**

1. **Cursor:** `$` ← FS skills (Phase 1); `/` provider entries remain empty until ACP follow-up.
2. Confirm web `ChatComposer` empty-state copy still makes sense when Cursor has `$` skills but no provider `/` list.
3. Confirm mobile `ThreadComposer` uses the same snapshot fields (no duplicate discovery).
4. Add/adjust presentation tests if Cursor skills need different install/source badges (`providerSkillPresentation`).
5. Explicitly do **not** start OpenCode or ACP command bridging unless the human unblocks.

**Acceptance criteria**

- [ ] Cursor `$` shows FS skills; Cursor provider `/` list empty (follow-up).
- [ ] No double-listing the same item under both `$` and `/`.
- [ ] Codex/Claude behavior unchanged.
- [ ] Manual QA checklist for web (mobile smoke optional).

**Provider menu matrix (target after Cursor v1; OpenCode still deferred)**

| Provider | `$`                    | `/` (provider entries)    |
| -------- | ---------------------- | ------------------------- |
| Codex    | skills                 | (unchanged)               |
| Claude   | (unchanged)            | slash commands            |
| Cursor   | FS Cursor skills       | empty until ACP follow-up |
| OpenCode | still empty (deferred) | empty                     |

**Estimated file touch list**

- `apps/web/src/components/chat/ChatComposer.tsx` (copy / filtering only if needed)
- `apps/web/src/providerSkillSearch.ts` / presentation helpers (only if needed)
- `apps/mobile/src/features/threads/ThreadComposer.tsx` (only if filtering differs)
- `apps/server/src/provider/Layers/CursorProvider.ts`
- Tests colocated with the above

---

### Phase 3 — Cursor ACP `/` follow-up (optional, after FS `$`)

**Intent:** Option A second half — ACP available commands as slash entries when snapshot-able.

**Work**

1. Research whether ACP available commands exist at probe time vs session-only.
2. If snapshot-able without a live session, map to `ServerProviderSlashCommand`.
3. If session-only, either defer again or design a minimal session→snapshot bridge (larger; needs explicit human go-ahead).
4. Ensure no double-listing with FS `$` skills.

**Acceptance criteria**

- [ ] Written decision: ship `/` now vs keep deferred.
- [ ] If shipped: Cursor `/` lists ACP commands; Codex/Claude unchanged.
- [ ] `:typecheck` + tests green.

**Estimated file touch list**

- `apps/server/src/provider/Layers/CursorProvider.ts`
- ACP helpers under `apps/server/src/provider/acp/`
- Composer presentation only if needed

---

### Phase 4 — OpenCode skills into snapshot (DEFERRED)

**Intent:** Second provider; do not start until human unblocks after Cursor FS `$`.

**Work (when unblocked)**

1. Extend `OpenCodeInventory` in `opencodeRuntime.ts` with `skills`.
2. **SDK path:** `client.app.skills()` (or current SDK method); soft-fail skills errors.
3. **CLI path:** CLI skills command if stable, else documented FS fallback (#3154 ideas).
4. Map → `ServerProviderSkill`; thread into `buildServerProvider`.
5. Unit tests for SDK-shaped and CLI/FS-shaped skills.
6. Revisit OpenCode select→send the same way as Cursor (listing vs provider interpretation).

**Acceptance criteria**

- [ ] Human explicitly unblocked OpenCode work.
- [ ] With OpenCode enabled and at least one skill available, snapshot `skills.length > 0` on SDK **and** local path (or tested fallback).
- [ ] Composer `$` returns those skills.
- [ ] Skills-only inventory failure does not mark whole provider `error`.
- [ ] `:typecheck` + focused OpenCode tests green.

**Estimated file touch list**

- `apps/server/src/provider/opencodeRuntime.ts`
- `apps/server/src/provider/Layers/OpenCodeProvider.ts`
- `apps/server/src/provider/Layers/OpenCodeProvider.test.ts`
- Fixtures under `apps/server/src/provider/**`

---

### Phase 5 — Workspace / cwd scoping (if needed)

**Intent:** Align with #3787/#4031 direction only after Cursor (and later OpenCode) global/project skills work.

**Work**

1. Determine whether Cursor (and later OpenCode) skills are already cwd-aware at scan time.
2. If provider probe uses a workspace cwd, pass it into discovery.
3. Optionally set `ServerProviderSkill.scope` for UI.
4. Prefer existing provider refresh hooks before inventing `listSkills` RPC.

**Acceptance criteria**

- [ ] Switching workspace changes project-scoped skills appropriately (or documented limitation).
- [ ] Global/user skills still appear when expected.
- [ ] No cross-workspace leakage of project-only skills in tests.
- [ ] `:typecheck` + scoping tests green.

**Estimated file touch list**

- Discovery helpers + `CursorProvider` (and OpenCode when live)
- Maybe `providerStatusCache.ts` if cache keys must include cwd

---

### Phase 6 — Tests + manual QA matrix

**Intent:** Harden and hand off shipped phases (Cursor-first).

**Work**

1. Expand unit/integration coverage for shipped phases:
   - Cursor FS discovery
   - Provider registry snapshot propagation (skills survive cache merge)
   - Composer search still filters `enabled: false`
   - Select→send behavior covered or manually signed off
2. Manual QA matrix (web; mobile optional):

| #   | Setup                                         | Action              | Expected                                            |
| --- | --------------------------------------------- | ------------------- | --------------------------------------------------- |
| 1   | Codex + known skill                           | `$` → select → send | skill listed and applied (Codex interprets `$name`) |
| 2   | Claude + known command                        | `/`                 | command listed                                      |
| 3   | Cursor + `.cursor/skills` fixture             | `$`                 | skill listed                                        |
| 4   | Cursor + listed skill                         | select → send       | skill applied/used (Phase 1 gate)                   |
| 5   | Cursor without skills                         | `$`                 | empty state (not crash)                             |
| 6   | Cursor ACP commands (only if Phase 3 shipped) | `/`                 | commands listed                                     |
| 7   | Disable a skill if applicable                 | `$`                 | omitted                                             |
| 8   | Provider switch Codex→Cursor                  | `$`/`/`             | lists follow selected provider                      |
| 9   | Workspace switch (if Phase 5)                 | `$`                 | project skills update                               |
| 10  | OpenCode rows                                 | —                   | skip until Phase 4 unblocked                        |

3. Run Solo `:typecheck`, `:lint`, `:test` (or project-standard CI subset).
4. Update user-facing docs only if the fork already documents provider skill UX — keep doc edits minimal.

**Acceptance criteria**

- [ ] All automated tests for shipped phases green under `:test` / focused suites.
- [ ] Manual matrix rows for shipped phases checked (OpenCode rows explicitly skipped if still deferred).
- [ ] Short “how Cursor skills are discovered and applied on send” note in PR description.

**Estimated file touch list**

- Tests across `apps/server/src/provider/**`
- `apps/web/src/providerSkillSearch.test.ts` (if new edge cases)
- Optional docs under `docs/providers/cursor.md`

---

## 5. Acceptance criteria (rollup)

| Phase | Ship gate                                                                               |
| ----- | --------------------------------------------------------------------------------------- |
| 0     | Empty-snapshot repro + baseline tests; document select=`$name` insert + no T3 expansion |
| 1     | Cursor FS `$` lists skills **and** select→send is useful for Cursor                     |
| 2     | Cursor `$` semantics correct; ACP `/` still deferred; Codex/Claude unchanged            |
| 3     | Optional ACP `/` follow-up                                                              |
| 4     | OpenCode `$` (SDK + local) — **deferred until human unblocks**                          |
| 5     | Cwd/workspace scoping correct or explicitly deferred with reason                        |
| 6     | Full test + QA matrix for shipped phases                                                |

---

## 6. Solo execution playbook

### Context

| Item                    | Value                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| Fork path               | `/Users/blaqat/dev/forks/t3code`                                         |
| Solo project            | **t3code**                                                               |
| `project_id`            | `5`                                                                      |
| **Only allowed agent**  | **Cursor** (`agent_tool_id: **8**`)                                      |
| Preferred control plane | Solo MCP (`select_project` → `spawn_agent` → `send_input`)               |
| Nested Task models      | **only** `composer-2.5-fast` or `cursor-grok-4.5-high-fast`              |
| Do not use              | Claude / OpenCode / Codex Solo agents; Solo CLI; assuming HTTP API is on |
| Deferred                | OpenCode implementation phases (Phase 4+) until human unblocks           |

### Processes already in `solo.yml`

| Process       | Command               | When to use                                           |
| ------------- | --------------------- | ----------------------------------------------------- |
| `:dev`        | `pnpm run dev`        | Full-stack manual QA                                  |
| `:dev:server` | `pnpm run dev:server` | Server-only iteration                                 |
| `:dev:web`    | `pnpm run dev:web`    | UI menu checks                                        |
| `:typecheck`  | `pnpm run typecheck`  | Every phase gate                                      |
| `:lint`       | `pnpm run lint`       | Before PR / Phase 6                                   |
| `:test`       | `pnpm run test`       | Every phase gate (or focused vitest first, then full) |

### Bootstrap (orchestrator / human via Solo MCP)

```text
1. select_project(project_id=5)
2. list_agent_tools  → confirm Cursor agent id is 8 (do not use other agent tools)
3. list_processes    → see :dev / :typecheck / :test entries
4. For implementation:
     spawn_agent(agent_tool_id=8, project_id=5, name="skills-phase-N")
     send_input(process_id=<new>, input=<phase prompt below>)
5. For verification (after agent claims done):
     start_process(process_name=":typecheck", project_id=5)
     start_process(process_name=":test", project_id=5)
     (Optional) start_process(process_name=":dev", project_id=5) for manual UI
6. Read tails via get_process_output / get_process_raw_output as needed
```

**Notes**

- **Cursor-only:** Every implementation agent must use `agent_tool_id: 8`. The user has a Cursor subscription only; do not recommend or spawn Claude/OpenCode/Codex Solo agents for this plan.
- OpenCode phases are deferred; spawn agents for Phases 0–2 (and 3/5/6 as needed for Cursor). Do not spawn Phase 4 (OpenCode) until the human says so.
- Command processes may need to be **trusted** in the Solo UI before MCP can start them.
- Prefer one Solo agent per phase (smaller blast radius). Resume with `send_input` rather than spawning duplicates.
- If the agent needs nested Task/subagents, it must pass an allowlisted model explicitly (`composer-2.5-fast` or `cursor-grok-4.5-high-fast`).

### Suggested prompt templates (per phase)

#### Phase 0

```text
Read docs/plans/cursor-opencode-skill-discovery.md (TL;DR + Phase 0).
Solo project_id=5. Spawn/continue as Cursor agent only (agent_tool_id=8). Nested Task models: only composer-2.5-fast or cursor-grok-4.5-high-fast.

Task: Phase 0 only — repro and baseline-test that Cursor provider snapshots expose skills: [] and slashCommands: [] (or omit → default empty). Confirm ChatComposer select inserts `$skillName ` and Cursor sendTurn does not expand skills. Do not implement discovery yet. OpenCode implementation is deferred (optional empty-array baseline only).
When done: summarize evidence, list files touched, run :typecheck (and focused tests). Stop.
```

#### Phase 1

```text
Read docs/plans/cursor-opencode-skill-discovery.md Phase 1.
You are a Cursor Solo agent (agent_tool_id=8, project_id=5). Nested models: only composer-2.5-fast or cursor-grok-4.5-high-fast.

Implement Cursor FS skill discovery into provider snapshot.skills. Soft-fail missing dirs. Unit-test with fixtures.
Then verify select→send: if `$name` is inert for Cursor ACP, apply the smallest fix so selecting a skill is useful on send.
Do not implement OpenCode. Do not implement ACP slashCommands unless required for the send-path fix.
Verify :typecheck + Cursor discovery tests. Stop at Phase 1 acceptance criteria.
```

#### Phase 2

```text
Read docs/plans/cursor-opencode-skill-discovery.md Phase 2.
Cursor Solo agent only (agent_tool_id=8). Nested models: only composer-2.5-fast or cursor-grok-4.5-high-fast.

Wire Cursor $ semantics for FS skills; leave Cursor provider / empty (ACP follow-up). Ensure Codex/Claude unchanged. Adjust empty-state copy only if misleading.
Do not start OpenCode. Verify :typecheck + relevant tests. Stop.
```

#### Phase 3 (optional ACP `/`)

```text
Read docs/plans/cursor-opencode-skill-discovery.md Phase 3.
Cursor Solo agent only (agent_tool_id=8). Nested models: only composer-2.5-fast or cursor-grok-4.5-high-fast.

Only if human asked for ACP / follow-up: wire Cursor ACP available commands into slashCommands when snapshot-able. Otherwise stop and report that Phase 3 remains deferred.
Verify :typecheck + tests. Stop.
```

#### Phase 4 (OpenCode — deferred)

```text
Do not run unless the human explicitly unblocked OpenCode.
Read docs/plans/cursor-opencode-skill-discovery.md Phase 4.
Still use Cursor Solo agent only (agent_tool_id=8, project_id=5). Nested models: only composer-2.5-fast or cursor-grok-4.5-high-fast.

Implement OpenCode skills into the provider snapshot for BOTH SDK and local CLI paths. Soft-fail skills errors. Map to ServerProviderSkill. Cherry-pick ideas from upstream #3154; do not merge the PR wholesale.
Verify with focused OpenCode tests + :typecheck. Stop at Phase 4 acceptance criteria.
```

#### Phase 5

```text
Read docs/plans/cursor-opencode-skill-discovery.md Phase 5.
Cursor Solo agent only (agent_tool_id=8). Nested models: only composer-2.5-fast or cursor-grok-4.5-high-fast.

Add cwd/workspace scoping for Cursor skills if Phase 1–2 discovery is not already project-aware. Align with ideas from #3787/#4031 without merging those PRs. Prefer refresh-on-probe over new listSkills RPC unless necessary.
Verify scoping tests + :typecheck. Stop.
```

#### Phase 6

```text
Read docs/plans/cursor-opencode-skill-discovery.md Phase 6.
Cursor Solo agent only (agent_tool_id=8). Nested models: only composer-2.5-fast or cursor-grok-4.5-high-fast.

Fill remaining automated tests and run the manual QA matrix for shipped Cursor phases. Skip OpenCode rows if Phase 4 still deferred. Run :typecheck, :lint, and :test. Report any skipped matrix rows and why.
Do not start unrelated refactors.
```

### Verification cadence

After each phase agent stops:

1. `start_process(:typecheck)` — must pass
2. Focused tests the agent names — must pass
3. `start_process(:test)` before merging a phase PR (or once before the final PR if stacking locally)
4. Manual `:dev` UI check when Cursor skills become non-empty (Phase 1+)

---

## 7. Risks / open questions (remaining)

Resolved and removed from this section: Cursor-first priority; FS before ACP; Solo = Cursor agent 8 only; listing vs runtime clarified (Codex OK with `$name`; Cursor send-path is a Phase 1 acceptance gate).

### Still open

1. ~~**Cursor skill roots**~~ — **Resolved:** project `.cursor/skills`, user `~/.cursor/skills` (not `skills-cursor` built-ins).
2. ~~**Cursor insert token if `$name` is inert**~~ — **Resolved:** keep `$name` insert UX; inject SKILL.md body on send (see §10).
3. **OpenCode CLI skills (when unblocked):** Stable CLI command vs FS fallback for local mode? _(deferred)_
4. ~~**Project-scoped skills / cwd**~~ — **Partially resolved:** listing uses `ServerConfig.cwd`; send-apply merges session cwd + server cwd. **Residual:** per-thread `$` menu still process-wide.
5. **Presentation:** `scope` / install badges for Cursor in the web skill picker (Codex has presentation heuristics)?
6. **Staleness:** Cache TTL / re-probe when user adds a skill while the app is running?
7. **Cursor ACP `/`:** still deferred (Phase 3).

---

## 8. File touch list (estimated by phase)

| Phase | Primary files                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------ |
| **0** | `CursorProvider.test.ts`; read `ChatComposer.tsx`, `CursorAdapter.ts`, `providerSnapshot.ts`; optional OpenCode baseline |
| **1** | `CursorProvider.ts`, new `cursorSkillDiscovery.ts`(+test); maybe `ChatComposer.tsx` for insert-form fix                  |
| **2** | Cursor provider; possibly `ChatComposer.tsx`, `ThreadComposer.tsx`, `providerSkillSearch.ts`, presentation tests         |
| **3** | Cursor ACP helpers + `CursorProvider` (optional follow-up)                                                               |
| **4** | `opencodeRuntime.ts`, `OpenCodeProvider.ts`(+test), fixtures — **deferred**                                              |
| **5** | Discovery helpers + provider probe cwd threading; maybe `providerStatusCache.ts`                                         |
| **6** | Tests across server/web; optional `docs/providers/cursor.md`                                                             |

**Shared contracts (touch sparingly):**

- `packages/contracts/src/server.ts` — `ServerProviderSkill` / `ServerProviderSlashCommand` already sufficient for v1
- `packages/shared/src/composerTrigger.ts` — trigger detection already supports `$` / `/`; unlikely to change

**UI already wired (prefer no discovery logic here):**

- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/providerSkillSearch.ts`
- `apps/mobile/src/features/threads/ThreadComposer.tsx`

---

## 9. Suggested PR stacking

1. `test(cursor): baseline empty skills snapshot` — Phase 0 (optional if tiny, fold into #2)
2. `feat(cursor): discover FS skills into provider snapshot` — Phase 1 (+ send-path fix if needed)
3. `fix(composer): align Cursor $ semantics` — Phase 2
4. `feat(cursor): ACP slash commands into snapshot` — Phase 3 (optional follow-up)
5. `feat(opencode): populate provider skills in snapshot (sdk + cli)` — Phase 4 (**deferred**)
6. `feat(providers): workspace-scope Cursor skills` — Phase 5 (optional)
7. Tests-only follow-up only if Phase 6 spills

---

## 10. Phase 0 repro notes (fill during Phase 0)

_Completed during Cursor FS skill implementation:_

- Cursor selected → `$` → empty before this work (`skills: []`); after → FS skills from `.cursor/skills` + `~/.cursor/skills`
- Select skill (once listed) inserts → `$skillName ` (unchanged composer UX)
- Cursor send path → `CursorAdapter.sendTurn` injects matched SKILL.md bodies (Codex-style `$name` is inert under ACP; `/name` not relied on)
- OpenCode selected → `$` → still empty (implementation deferred)
- Snapshot evidence: `buildCursorProviderSnapshot({ skills })` + `cursorSkillDiscovery.test.ts`
- Date / commit SHA: see `feat/cursor-fs-skill-discovery`

### Send-apply choice (Phase 1)

Cursor ACP `session/prompt` receives plain text. Unlike Codex, there is no runtime `$skill` interpreter. T3 therefore rediscovers FS skills for the session cwd on send and **injects SKILL.md content** for matched `$name` tokens before building prompt parts. Composer insert remains `$name` for UX parity with Codex.
