# AGENT_SWARM.md — Session: T3 Rework Sprint 1

Follow the **2026 Multi-Agent Standard** (see [`2026_agent_schema.md`](./2026_agent_schema.md)).
This file is the single source of truth for the session. Read it at the start of every phase.

---

## SESSION CONFIG (defined by HEAD_DEV)

**Goal:** Rework T3 Code to support (1) **multiple instances on one PC** (Cursor-style) and
(2) a **Claude Remote Control launch feature** so a T3-managed Claude session can be driven from
the Claude iPhone/web app.

**Roster:**

| Codename | Domain |
| --- | --- |
| **HELM** | Core / multi-instance: server config, base-dir isolation, instance registry + discovery, `t3 instances` CLI, root command wiring (`bin.ts`). **Tiebreaker authority for core/architecture.** |
| **BEACON** | Claude Remote Control: `t3 remote-control` / `rc` CLI command + launcher module that spawns the real `claude` CLI in remote-control mode using the selected Claude HOME/account. In-app launch via the terminal subsystem. |
| **ATLAS** | Integration surfaces + docs + deliverable: UI design specs for the instance switcher and the Remote Control action, all user/architecture docs, and the **session deliverable** `SPRINT_1_DELIVERABLE.md`. |
| **HEAD_DEV** | Orchestrator (the human's Claude Code session). Did the initial cross-cutting AUDIT below. Owns `bin.ts` final integration, conflict resolution outside core, and final VERIFY/HANDOFF. |

**Shared-file concurrency override (session-specific rule):** Because agents run concurrently and a
single file cannot be safely appended to in parallel, each agent keeps its **own append-only log** at
`swarm/<CODENAME>.md`. This master file holds HEAD_DEV entries, the contracts, and the conflict
table. Treat `swarm/<CODENAME>.md` as that agent's append-only record (never edit another agent's
log). This overrides the schema's "one physical file" default while preserving append-only + the
message format.

**Deliverable:** `SPRINT_1_DELIVERABLE.md` (authored by ATLAS at HANDOFF).

**Verification reality:** This is a fresh clone. Dependencies are **not installed** and the `vp`
(Vite+) toolchain is **not present**, so `vp check` / `vp run typecheck` cannot be run this session.
Verification is by code reading + reasoning only. Prefer **additive new files** over edits to large
existing modules; keep edits to hot files surgical and clearly marked. Anything not safely completable
without a typecheck must be specified precisely in the deliverable for a follow-up pass rather than
half-implemented.

---

## HEAD_DEV AUDIT (grounding — verified against source)

```
FROM: HEAD_DEV
TO: ALL
PHASE: AUDIT
CONFIDENCE: HIGH
REFS: apps/server/src/config.ts, apps/server/src/cli/config.ts, apps/server/src/bin.ts,
      apps/server/src/provider/Drivers/ClaudeDriver.ts,
      apps/server/src/provider/Layers/ClaudeAdapter.ts,
      apps/server/src/provider/Drivers/ClaudeHome.ts,
      apps/server/src/terminal/Services/Manager.ts
```

**Architecture:** T3 = Node WebSocket server (`apps/server`) wrapping coding-agent runtimes + a
React/Vite client (`apps/web`), Electron shell (`apps/desktop`), pnpm workspaces, Effect + Effect
Schema, custom `effect/unstable/cli` for the `t3` binary. Build tool is `vp` (Vite+).

**Finding 1 — Multi-instance is already partially supported at the CLI layer.**
- `apps/server/src/config.ts`: `DEFAULT_PORT = 3773`. All runtime state derives from a single
  `baseDir` (sqlite db, settings, logs, secrets, worktrees) via `deriveServerPaths(baseDir)`.
- `apps/server/src/cli/config.ts` `resolveServerConfig`: in **web** mode with no `--port`, it already
  calls `findAvailablePort(DEFAULT_PORT)` → **dynamic port works today**. In **desktop** mode it pins
  `DEFAULT_PORT`. `baseDir` resolves from `--base-dir` / `T3CODE_HOME` / `resolveBaseDir(undefined)`.
- **Gaps for true multi-instance:** (a) default `baseDir` is shared, so two default instances collide
  on one sqlite/state; (b) no instance **registry/discovery** (nothing records "instance X at port P,
  baseDir B, pid, cwd"); (c) **desktop** app is single-instance + fixed port (confirm
  `requestSingleInstanceLock` in `apps/desktop/src/electron/ElectronApp.ts`).

**Finding 2 — Claude is driven only through the Agent SDK; Remote Control is CLI-only.**
- `ClaudeDriver.ts` / `ClaudeAdapter.ts` use `query()` from `@anthropic-ai/claude-agent-sdk`
  (headless). The official **Remote Control** feature (`claude remote-control`, `claude --remote-control`
  / `--rc`, in-session `/remote-control`) is **not exposed by the Agent SDK at all** — confirmed against
  official docs (code.claude.com/docs/en/remote-control). It needs claude.ai OAuth (Pro/Max/Team/Ent),
  registers the local `claude` process with the Anthropic API over outbound HTTPS, and Anthropic relays
  to the Claude mobile/web app. **Therefore T3 must LAUNCH the real `claude` CLI in RC mode** — it
  cannot enable RC on its SDK sessions. (HEAD_DEV decision, user-confirmed: "Launch CLI in RC mode".)
- Reuse for the launcher: `apps/server/src/provider/Drivers/ClaudeHome.ts` (`makeClaudeEnvironment`,
  HOME/account resolution), `ProviderInstanceEnvironment` env merge, `@t3tools/shared/cliArgs`
  `parseCliArgs`. In-app interactive launch → `apps/server/src/terminal/Services/Manager.ts`.

**Finding 3 — CLI command wiring.** Commands are `Command.make(...)` registered in
`apps/server/src/bin.ts` via `Command.withSubcommands([...])`. New commands plug in there. `bin.ts` is
a shared integration point → owned by HELM; BEACON exports its command for HELM to register.

---

## CONTRACTS (cross-domain — agree before IMPLEMENT; HEAD_DEV-proposed)

**C1 — Instance registry record (HELM owns the type).** A running instance announces itself by writing
a JSON lock file under a shared dir (proposed `<defaultBaseRoot>/instances/<instanceId>.json`):
```jsonc
{ "instanceId": "string", "name": "string|null", "pid": 1234, "port": 51234,
  "host": "127.0.0.1", "baseDir": "abs/path", "cwd": "abs/path",
  "startedAt": "ISO", "schemaVersion": 1 }
```
Stale entries (dead pid) are pruned on read. `t3 instances` lists live entries. ATLAS designs the UI
against this shape; BEACON may read it to show "which instance launched the RC session".

**C2 — `--instance <name>` convenience (HELM).** Maps a friendly name to a deterministic per-instance
`baseDir` (e.g. `<defaultBaseRoot>/instances-data/<name>`), so `t3 start --instance work` and
`t3 start --instance personal` are fully isolated without manual `--base-dir`.

**C3 — RC launcher (BEACON).** `t3 remote-control [--account/--claude-home <path>] [--name <title>]
[--server | --interactive] [cwd]`. Resolves the `claude` binary + HOME via ClaudeHome helpers, spawns
`claude remote-control` (server) or `claude --remote-control` (interactive), inherits/streams stdio so
the pairing/registration output is visible. Exposes a `remoteControlCommand` export for HELM to wire
into `bin.ts`. In-app variant: launch `claude --remote-control` through the terminal Manager service.

**C4 — `bin.ts` ownership (conflict resolution).** Only **HELM** edits `apps/server/src/bin.ts`. HELM
registers both its own `instancesCommand` and BEACON's `remoteControlCommand`. BEACON must NOT edit
`bin.ts`; it only exports its command.

---

## OUTPUTS MAP (disjoint file domains — no two agents touch the same file)

**HELM**
- `apps/server/src/instances/` (new): `InstanceRegistry.ts` (+ test), record schema in/near contracts.
- `apps/server/src/cli/instances.ts` (new): `t3 instances` command.
- `apps/server/src/cli/config.ts` (edit): add `--instance` flag → per-instance baseDir.
- `apps/server/src/bin.ts` (edit): register `instancesCommand` + `remoteControlCommand`.
- `apps/server/src/server.ts` (edit, surgical): announce/withdraw instance in registry on start/stop.
- `apps/desktop/src/electron/ElectronApp.ts` (edit/spec): multi-window / drop single-instance pin —
  implement if low-risk, else SPEC it for the deliverable.

**BEACON**
- `apps/server/src/remoteControl/` (new): `ClaudeRemoteControlLauncher.ts` (+ test), errors.
- `apps/server/src/cli/remoteControl.ts` (new): `t3 remote-control` / `rc` command (exports command).
- Read-only reuse: `provider/Drivers/ClaudeHome.ts`, `terminal/Services/Manager.ts`,
  `@t3tools/shared/cliArgs`. **Do NOT edit `bin.ts`** (C4).

**ATLAS**
- `docs/architecture/multi-instance.md` (new), `docs/user/remote-control.md` (new).
- `docs/providers/claude.md` (edit: add RC section), `docs/user/remote-access.md` (edit: link RC),
  `docs/architecture/runtime-modes.md` (edit: note RC vs SDK).
- `docs/architecture/web-surfaces-spec.md` (new): instance-switcher + RC-action UI design spec
  (concrete component sketch; no compile-risky web code unless trivially safe).
- `SPRINT_1_DELIVERABLE.md` (new): the session deliverable.

---

## CONFLICT TABLE

| File | Claimed by | Status |
| --- | --- | --- |
| `apps/server/src/bin.ts` | HELM (registers BEACON's export) | RESOLVED — C4 |
| `apps/server/src/cli/config.ts` | HELM only | RESOLVED |
| `docs/providers/claude.md` | ATLAS only | RESOLVED |

No other overlaps. If a new overlap appears, both agents STOP and post to their logs; HELM is
tiebreaker for core, HEAD_DEV otherwise.

---

## PHASE STATUS

| Agent | AUDIT | DESIGN | IMPLEMENT | VERIFY | HANDOFF |
| --- | --- | --- | --- | --- | --- |
| HELM | ✅ | ✅ | ✅ (desktop multi-window = specced) | ✅ | ✅ |
| BEACON | ✅ | ✅ | ✅ (in-app PTY launch = specced) | ✅ | ✅ |
| ATLAS | ✅ | ✅ | ✅ | ✅ | ✅ |
| HEAD_DEV | ✅ | ✅ | ✅ (bin.ts wiring) | ✅ | ✅ |

---

## HEAD_DEV INTEGRATION + VERIFY

```
FROM: HEAD_DEV
TO: ALL
PHASE: VERIFY
CONFIDENCE: HIGH (structure/contracts) · MEDIUM (exact Effect API spellings — no vp check this session)
REFS: apps/server/src/bin.ts, apps/server/src/instances/InstanceRegistry.ts,
      apps/server/src/cli/instances.ts, apps/server/src/cli/remoteControl.ts,
      apps/server/src/remoteControl/ClaudeRemoteControlLauncher.ts,
      apps/server/src/cli/config.ts, apps/server/src/config.ts, apps/server/src/server.ts
```

**Integration done:** Wired both new subcommands into `bin.ts` (`instancesCommand`, `remoteControlCommand`)
— the one shared file no agent edited. No file-domain conflicts occurred; all three agents stayed
inside their OUTPUTS blocks. Cross-checked: registry exports ↔ consumers match; the C1 record shape is
identical across InstanceRegistry.ts (impl), server.ts (announce), cli/instances.ts (print), and
ATLAS's docs. `--instance` precedence preserves existing `--base-dir`/`T3CODE_HOME` behavior. RC
command launches the real `claude` CLI only (no SDK RC, no custom relay) — matches user decision.

**Open verification checklist (requires `vp i` + `vp check` once deps are installed — cannot run this
session):** confirm exact Effect API spellings used by the new code against the installed version —
`Schema.fromJsonString` / `Schema.decodeUnknownEffect` / `Schema.encodeEffect`,
`Effect.ignore({ log: true })`, `FileSystem.remove(..., { force: true })`, and that `Crypto.Crypto`
is in `makeServerLayer`'s context for the announce step. These are the only MEDIUM-confidence points;
structure and contracts are HIGH. See `SPRINT_1_DELIVERABLE.md` for the full checklist.

OUTPUTS_DECLARED: apps/server/src/bin.ts (registration only)
BLOCKING_ON: NONE
REVERSIBLE: YES — every change is additive new files + surgical, clearly-marked edits.
