# Sprint 1 Deliverable — T3 Rework

Session: T3 Rework Sprint 1
Schema: 2026 Multi-Agent Standard
Date: 2026-06-07
Deliverable author: ATLAS
Final status: **Integrated and VERIFIED by HEAD_DEV. Server package typecheck is green and the two
new unit suites pass (14/14). Code-complete except two explicitly-specced items (desktop multi-window,
in-app PTY launch). See the verification results at the end.**

> HEAD_DEV finalizes the "Status" column after integration is complete.
> Entries marked "SPEC" mean code was specified but not implemented this sprint.

---

## Changes by Agent

### ATLAS — Docs + UI Design Spec

| File | Action | Status | Notes |
| --- | --- | --- | --- |
| `docs/architecture/multi-instance.md` | Created | DONE | Per-instance baseDir isolation, dynamic port, C1 registry shape, `--instance` convenience (C2), `t3 instances`, desktop multi-window spec |
| `docs/user/remote-control.md` | Created | DONE | Full user guide: prerequisites, CLI flags, in-app launch, pairing steps, troubleshooting, comparison with Remote Access |
| `docs/architecture/web-surfaces-spec.md` | Created | DONE | ASCII-mockup UI spec for instance switcher (Connections panel) + RC action (Claude provider card); data sources from C1 + C3 called out |
| `docs/providers/claude.md` | Edited — appended RC section | DONE | Adds "Remote Control" section linking to user guide; clarifies RC vs Remote Access in one paragraph |
| `docs/user/remote-access.md` | Edited — added cross-link note | DONE | Adds callout at top distinguishing Remote Access from Remote Control with link |
| `docs/architecture/runtime-modes.md` | Edited — appended RC note | DONE | Adds "Remote Control is outside the SDK runtime" note; clarifies Full access/Supervised modes do not apply to RC sessions |
| `SPRINT_1_DELIVERABLE.md` | Created | DONE | This file |
| `swarm/ATLAS.md` | Created | DONE | Append-only ATLAS agent log (AUDIT → DESIGN → IMPLEMENT → VERIFY → HANDOFF) |

---

### HELM — Core / Multi-instance (contracted work, implementation status TBD)

| File | Action | Intended | Status |
| --- | --- | --- | --- |
| `apps/server/src/instances/InstanceRegistry.ts` | Create | Instance registry: write/read/prune lock files, C1 record schema | DONE — exports match consumers |
| `apps/server/src/instances/InstanceRegistry.test.ts` | Create | Unit tests for registry | DONE |
| `apps/server/src/config.ts` | Edit | Add optional `instanceName?` to `ServerConfigShape` | DONE — optional, omitted by default (tests unaffected) |
| `apps/server/src/cli/instances.ts` | Create | `t3 instances` command (`--json`) | DONE |
| `apps/server/src/cli/config.ts` | Edit | Add `--instance <name>` flag → per-instance baseDir (C2) | DONE — explicit base-dir/env precedence preserved |
| `apps/server/src/server.ts` | Edit (surgical) | Announce/withdraw instance in registry on start/stop | DONE — failure-isolated `acquireRelease` layer |
| `apps/server/src/bin.ts` | Edit (by HEAD_DEV) | Register `instancesCommand` + `remoteControlCommand` (C4) | DONE — HEAD_DEV wired both |
| `apps/desktop/src/electron/ElectronApp.ts` | SPEC only | Multi-window / drop single-instance lock | SPEC — single-instance gate is in `DesktopCloudAuth.ts`; desktop backend port already dynamic. See open Q1 |

---

### BEACON — Claude Remote Control (contracted work, implementation status TBD)

| File | Action | Intended | Status |
| --- | --- | --- | --- |
| `apps/server/src/remoteControl/ClaudeRemoteControlLauncher.ts` | Create | Spawns `claude remote-control` (server) or `claude --remote-control` (interactive); resolves binary + HOME via `makeClaudeEnvironment`; inherits/streams stdio | DONE |
| `apps/server/src/remoteControl/ClaudeRemoteControlLauncher.test.ts` | Create | Unit tests assert argv + binary + resolved HOME env; never spawns real `claude` | DONE |
| `apps/server/src/remoteControl/Errors.ts` | Create | Typed errors (`ClaudeRemoteControlLaunchError`, `ClaudeRemoteControlExitError`) | DONE |
| `apps/server/src/cli/remoteControl.ts` | Create | `t3 remote-control` / `rc` command; prints OAuth-required note; exports `remoteControlCommand` (HEAD_DEV registered it; `bin.ts` untouched by BEACON per C4) | DONE |
| In-app PTY-hosted launch (`claude --remote-control` via terminal Manager) | SPEC only | Terminal `Services/Manager.ts` ships only the interface; no concrete PTY layer or "run argv+env in PTY" entry point in this clone | SPEC — needs a terminal API extension (see open Q2) |

---

## Intended vs Done (ATLAS scope)

| Intended | Done |
| --- | --- |
| multi-instance.md grounded in Finding 1 (dynamic port, baseDir, missing registry/discovery) | Yes — cites `findAvailablePort`, `DEFAULT_PORT`, `deriveServerPaths`, C1 shape, C2 convenience |
| remote-control.md explains RC as CLI launch (not SDK), requires claude.ai OAuth | Yes — clearly distinguishes SDK sessions from RC; prerequisites state Pro/Max/Team/Enterprise |
| remote-control.md covers in-app and CLI paths | Yes — CLI flags table + in-app Settings → Providers path |
| remote-control.md has explicit "How this differs from Remote Access" subsection | Yes — comparison table in subsection |
| claude.md gets RC section linking to user guide | Yes — appended as final section |
| remote-access.md gets cross-link clarifying it is NOT RC | Yes — callout note at top of doc |
| runtime-modes.md gets note that RC is outside the SDK runtime | Yes — appended section |
| web-surfaces-spec.md has ASCII mockups for both instance switcher and RC action | Yes — both surfaces mocked with data sources, states, and interaction notes |
| web-surfaces-spec.md identifies data each surface consumes | Yes — C1 registry fields and ProviderInstanceConfig fields listed per surface |
| SPRINT_1_DELIVERABLE.md covers all agents + open questions | Yes — this file |

---

## Open Questions for HEAD_DEV

1. **Desktop multi-window (HELM scope):** Should HELM implement the multi-window Electron changes
   (`apps/desktop/src/electron/ElectronApp.ts`) this sprint, or spec them for Sprint 2?
   The risk is non-trivial (removing `requestSingleInstanceLock` affects the existing single-
   instance guarantee). ATLAS has documented the target behavior in `multi-instance.md`.

2. **RC in-app trigger RPC:** The web surfaces spec calls for a server RPC that the RC Launch
   button invokes. BEACON's contract (C3) covers the CLI path and terminal Manager launch, but
   the exact RPC shape (WebSocket message type, payload) is not yet contracted. HELM and BEACON
   should agree on this before ATLAS finalizes the spec's "data source" section.

3. **RC pairing-confirmed detection:** The "Paired" state in the RC action mockup depends on
   detecting a pairing-confirmed string in the `claude` process stdout. The exact string varies
   by `claude` CLI version. Should T3 parse this heuristically (fragile) or wait for a future
   claude CLI API to expose pairing state? Recommendation: ship with terminal-output-only
   (user reads the terminal panel), and add auto-detection later when the string is stable.

4. **`t3 instances` RPC vs CLI-only:** The instance switcher UI reads the registry via a server
   RPC. HELM should confirm that the registry-read logic is exposed over WebSocket (not only
   as a CLI command) so the UI can consume it. If the server always has access to the shared
   lock file directory, this is straightforward — flagging for explicit sign-off.

5. **Instance switcher in web vs desktop:** The "Open new window" action in the instance switcher
   requires Electron multi-window support (deferred per open question 1). In the web client,
   "Open" can open a new browser tab. Should the spec show different behavior per client type,
   or should "Open" be hidden in web for Sprint 1? Recommendation: hide in web until multi-window
   desktop lands; then revisit for consistency.

6. **BEACON agents log:** No `swarm/BEACON.md` or `swarm/HELM.md` existed when ATLAS ran.
   ATLAS proceeded on contracts as instructed. If HELM or BEACON produced conflicting design
   decisions in their own sessions, HEAD_DEV should reconcile before integration.

---

## Deferred to Next Sprint

| Item | Reason | Owner |
| --- | --- | --- |
| Desktop multi-window (Electron `requestSingleInstanceLock` removal + per-window port) | Risk assessment needed; non-trivial reversal path | HELM + HEAD_DEV |
| TypeScript component code for instance switcher | Spec-only this sprint; no typecheck toolchain available | ATLAS → implementation sprint |
| TypeScript component code for RC action in provider card | Spec-only this sprint | ATLAS → implementation sprint |
| RC pairing-confirmed auto-detection (terminal output parsing) | Fragile until CLI string is stable | BEACON → future sprint |
| `t3 instances` RPC shape formal contract | Needs HELM sign-off | HELM → Sprint 2 contract |
| RC WebSocket RPC shape | Needs HELM + BEACON alignment | HELM + BEACON → Sprint 2 |
| `docs/README.md` and `README.md` links to new guides | Low priority housekeeping | HEAD_DEV or ATLAS Sprint 2 |

---

## Notes

- All ATLAS file changes are docs and specs only. No TypeScript application code was written.
  This is correct per ATLAS domain and the "no compile-risky code" session rule.
- All edits to existing docs are additive (append or prepend). No existing content was removed.
- The UI design spec references exact C1 and C3 contract shapes from `AGENT_SWARM.md`.
  If HELM changes the C1 shape before implementation, the spec should be updated to match.
- HEAD_DEV finalizes the Status column for HELM and BEACON rows after reviewing their logs
  and integration output.

---

## HEAD_DEV Finalization

**Integration:** `bin.ts` now imports and registers both `instancesCommand` and `remoteControlCommand`
in `makeCli`'s subcommand list. No file-domain conflicts occurred — all three agents stayed inside
their OUTPUTS blocks. Cross-domain shapes verified consistent (C1 record identical across impl,
announce, print, and docs).

**Resolutions to the open questions:**

1. **Desktop multi-window:** Deferred to Sprint 2 (correctly specced, not coded). HELM found the
   single-instance gate lives in `DesktopCloudAuth.ts` (OAuth deep-link handling), not `ElectronApp.ts`,
   and the desktop backend port is *already* dynamic (`resolveDesktopBackendPort` scans from 3773).
   Each desktop window already runs `server.ts`, so it already announces into the shared registry —
   discovery works today; only the single-window *gate* needs lifting. This is the right risk call.
2. **RC in-app trigger RPC + 3. pairing detection + in-app PTY launch:** Deferred together. The CLI
   path (`t3 remote-control` / `rc`) is the shippable Sprint-1 surface. The in-app button needs a
   terminal "run argv+env in PTY" entry point that this clone's `terminal/Services/Manager.ts` does not
   yet expose. Sprint 2: add that entry point, then the WebSocket RPC + the provider-card action.
   Ship RC pairing as terminal-output-only first (no fragile stdout parsing).
4. **`t3 instances` over RPC:** The registry reads a shared on-disk dir, so any server process can list
   it. Exposing it over WebSocket for the UI is a thin Sprint-2 addition; the CLI command works now.
6. **Agent-log race:** Both `swarm/HELM.md` and `swarm/BEACON.md` exist; no conflicting design
   decisions — HELM's C1 shape and BEACON's CLI match what ATLAS documented. Reconciled.

**Verification results (vp toolchain installed; Node 24.16.0 via `vp env`):**

- [x] `vp run --filter t3 typecheck` (tsgo) on `apps/server` — **green** after fixes below.
- [x] Effect API spellings confirmed against the installed version (`Schema.fromJsonString`,
      `Effect.ignore({ log: true })`, `FileSystem.remove(..., { force: true })` all valid; the only
      real fixes were `Order.String` casing and providing `FileSystem`/`Path` to `announce`).
- [x] `Crypto.Crypto` resolves in `makeServerLayer`'s context — `server.ts` typechecks clean.
- [x] `ChildProcessSpawner` + `Path` resolve from `bin.ts`'s `CliRuntimeLayer` — RC command typechecks clean.
- [x] `vp test run` for `InstanceRegistry.test.ts` and `ClaudeRemoteControlLauncher.test.ts` — **14/14 pass.**
- [ ] Manual smoke (needs a real Claude Pro/Max login): `t3 start --instance work` +
      `t3 start --instance personal` → two isolated instances on distinct ports; `t3 instances` lists
      both; `t3 remote-control` launches `claude` in RC mode and pairs with the phone.

**Fixes applied during verification (all in new/owned files):** `cli/instances.ts` used a
non-existent `InstanceRegistry.layer` static (now imports the `layer` export); `InstanceRegistry.ts`
used `Order.string` (→ `Order.String`) and leaked `FileSystem | Path` from `announce` (now provided);
test type-widening + one lint directive; and the RC launcher test's HOME assertion was made
platform-agnostic via `path.resolve`. Net: typecheck green, 14/14 unit tests pass.

**Note:** two failures in the pre-existing `provider/Layers/ProviderInstanceRegistryLive.test.ts` are
not part of this work — they hardcode POSIX paths (`/home/julius/.codex`) and fail only on Windows
(`path.resolve` → `C:\home\julius\.codex`). They pass on the Linux CI and are unrelated to these changes.
