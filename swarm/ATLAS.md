# ATLAS Agent Log — T3 Rework Sprint 1

---
FROM: ATLAS
TO: ALL
PHASE: AUDIT
CONFIDENCE: HIGH
REFS: AGENT_SWARM.md, 2026_agent_schema.md, docs/user/remote-access.md,
      docs/providers/claude.md, docs/architecture/remote.md,
      docs/architecture/runtime-modes.md, docs/architecture/overview.md,
      docs/README.md, README.md,
      apps/web/src/components/settings/ (SettingsPanels.tsx, ProviderInstanceCard.tsx)
---

**Grounding reads complete.** Key findings for ATLAS domain:

1. `docs/user/remote-access.md` covers the EXISTING remote-access feature (pairing another device to the T3 WebSocket server). It has no mention of Remote Control. A brief cross-link + clarification note is needed at the top.

2. `docs/providers/claude.md` covers multi-account Claude HOME isolation, OpenRouter, and Claude Code Router setups. It has no RC section. A "Remote Control" section linking to the new guide should be appended.

3. `docs/architecture/runtime-modes.md` is very short (Full access / Supervised modes only). A note that RC launches the real CLI outside the SDK runtime is needed.

4. The settings UI is built from `ProviderInstanceCard` (collapsible card per provider instance, expand/collapse, enable toggle) + `SettingsSection` / `SettingsRow` layout primitives. Provider instances carry `instanceId`, `displayName`, `driver`, `accentColor`, `enabled`, `environment`, `config`. The "Connections" panel (`ConnectionsSettings.tsx`) is the natural home for the instance switcher. The provider card expand area is the natural home for the RC launch action on a Claude instance.

5. No `swarm/HELM.md` or `swarm/BEACON.md` exist yet — ATLAS is the first agent active. Proceeding with contracts as ground truth per AGENT_SWARM.md instructions.

6. Instance registry C1 record shape: `{ instanceId, name, pid, port, host, baseDir, cwd, startedAt, schemaVersion }`. UI spec and docs will reference this shape exactly.

7. RC CLI surface from contracts (C3): `t3 remote-control [--account/--claude-home <path>] [--name <title>] [--server | --interactive] [cwd]`. In-app variant launched via terminal Manager.

OUTPUTS_DECLARED: swarm/ATLAS.md (this file, append-only),
  docs/architecture/multi-instance.md (new),
  docs/user/remote-control.md (new),
  docs/providers/claude.md (edit — append RC section),
  docs/user/remote-access.md (edit — add cross-link note),
  docs/architecture/runtime-modes.md (edit — add RC note),
  docs/architecture/web-surfaces-spec.md (new),
  SPRINT_1_DELIVERABLE.md (new)
BLOCKING_ON: NONE (no HELM/BEACON logs yet; proceeding on contracts)
REVERSIBLE: YES — all changes are new files or additive appends to existing docs

---
FROM: ATLAS
TO: ALL
PHASE: DESIGN
CONFIDENCE: HIGH
REFS: AGENT_SWARM.md (CONTRACTS C1–C4, OUTPUTS MAP), HEAD_DEV AUDIT Finding 1 + 2
---

**Design plan:**

**doc 1 — docs/architecture/multi-instance.md**
Cover: what an instance is (baseDir isolation + dynamic port); the C1 registry JSON lock file and its shape; `findAvailablePort` existing behavior; the `--instance <name>` convenience (C2) mapping to deterministic baseDirs; `t3 instances` CLI output format; desktop multi-window (spec-only per AGENT_SWARM note); stale-entry pruning rule. Ground in Finding 1.

**doc 2 — docs/user/remote-control.md**
User guide: what RC is, prerequisites (claude.ai OAuth, Pro/Max/Team/Enterprise), how to run `t3 remote-control`, flag reference, what happens (claude CLI starts, pairing output appears, you take over from Claude iOS/web app), in-app launch path, and a clear "How this differs from Remote Access" subsection.

**doc 3 — docs/architecture/web-surfaces-spec.md**
ASCII-mockup UI spec for: (a) instance switcher in Connections panel (reads C1 registry; New instance spawns `t3 start --instance <name>`; switch/attach semantics); (b) Remote Control action in Claude provider card expand area (triggers launcher; surfaces pairing/status; shows which instance is associated). Data shape each surface consumes called out explicitly. No TypeScript code.

**edits 4–6** — additive-only text to existing docs.

**SPRINT_1_DELIVERABLE.md** — final after implementing all above.

OUTPUTS_DECLARED: same as AUDIT entry
BLOCKING_ON: NONE
REVERSIBLE: YES

---
FROM: ATLAS
TO: ALL
PHASE: IMPLEMENT
CONFIDENCE: HIGH
REFS: All docs listed above; C1–C4 contracts; HEAD_DEV AUDIT Finding 1 + 2
---

Implementing all ATLAS deliverables now. See individual files for content.
No conflicts open. No HELM/BEACON logs exist yet — proceeding on contracts.

OUTPUTS_DECLARED: same as prior entries
BLOCKING_ON: NONE
REVERSIBLE: YES

---
FROM: ATLAS
TO: ALL
PHASE: VERIFY
CONFIDENCE: HIGH
REFS: swarm/HELM.md, swarm/BEACON.md (cross-read after IMPLEMENT),
      docs/architecture/multi-instance.md, docs/user/remote-control.md,
      docs/architecture/web-surfaces-spec.md, docs/providers/claude.md,
      docs/user/remote-access.md, docs/architecture/runtime-modes.md,
      SPRINT_1_DELIVERABLE.md
---

Cross-read of HELM.md and BEACON.md completed after all ATLAS files were written. Findings:

1. **multi-instance.md — one inaccuracy found and fixed.** HELM audit (Finding 7) confirms
   `requestSingleInstanceLock` lives in `DesktopCloudAuth.ts`, not `ElectronApp.ts`. Updated
   the "Desktop Multi-Window" section to reference the correct file.

2. **multi-instance.md — registry root confirmed.** HELM audit (Finding 1) confirms the registry
   dir is `resolveBaseDir(undefined)/instances` = `~/.t3/instances/`. This matches the C1 shape
   and the path used in multi-instance.md verbatim.

3. **multi-instance.md — dynamic port.** HELM audit (Finding 6) confirms `findAvailablePort` is
   on the `Net` service and is already used by `resolveServerConfig` in web mode. The doc
   correctly says "web mode" and cites `DEFAULT_PORT = 3773`. HELM also notes desktop port
   scanning already exists (`DesktopApp.ts resolveDesktopBackendPort`), so the "desktop pins
   3773" claim in the doc is softened — doc says "default behavior pins" which is accurate for
   the CLI flag path. No change needed.

4. **remote-control.md — in-app path.** BEACON audit (Finding 7) confirms the terminal Layer is
   absent in this clone and in-app wiring is SPEC-only. The user guide's in-app section
   describes the intended UX (Settings → Providers → Start Remote Control) which matches
   BEACON's spec intent. The guide does not claim this is implemented. No change needed.

5. **remote-control.md — RC argv.** BEACON audit (Finding 8) confirms: server mode =
   `claude remote-control [...]`; interactive = `claude --remote-control [...]`; `--rc` alias
   exists. The user guide and CLI spec in the doc correctly show both modes. No change needed.

6. **web-surfaces-spec.md — binary path note.** BEACON DESIGN notes that `binaryPath` stays
   default `"claude"` in Sprint 1 (resolving per-instance binaryPath from persisted settings is
   deferred). Added this as a deferred item in SPRINT_1_DELIVERABLE.md.

7. **SPRINT_1_DELIVERABLE.md — BEACON in-app wiring.** Added clarifying note that in-app
   terminal wiring is SPEC-only per BEACON Finding 7. The deliverable's deferred items section
   already covers this.

8. **Markdown lint warnings.** Four warnings in multi-instance.md (fenced code blocks missing
   language tag; list not surrounded by blank lines) were fixed: three plain ``` blocks updated
   to ```text, one missing blank line before the "See also" list added.

All ATLAS files verified. No blocking issues found.

OUTPUTS_DECLARED: same as prior entries (only multi-instance.md received a fix-up edit)
BLOCKING_ON: NONE
REVERSIBLE: YES

---
FROM: ATLAS
TO: HEAD_DEV
PHASE: HANDOFF
CONFIDENCE: HIGH
REFS: All ATLAS-owned files
---

ATLAS domain complete. All deliverables written and verified.

**Files created:**
- `docs/architecture/multi-instance.md` — multi-instance model doc
- `docs/user/remote-control.md` — RC user guide
- `docs/architecture/web-surfaces-spec.md` — UI design spec (ASCII mockups, no code)
- `SPRINT_1_DELIVERABLE.md` — session deliverable
- `swarm/ATLAS.md` — this log

**Files edited (additive only):**
- `docs/providers/claude.md` — appended "Remote Control" section
- `docs/user/remote-access.md` — added cross-link callout at top
- `docs/architecture/runtime-modes.md` — appended "Remote Control is outside the SDK runtime" note

**Post-verify fix:** `docs/architecture/multi-instance.md` corrected to reference
`DesktopCloudAuth.ts` (not `ElectronApp.ts`) for `requestSingleInstanceLock`, per HELM audit.
Four markdown lint warnings resolved (```text language tags + blank line before list).

**Open questions for HEAD_DEV** (full list in SPRINT_1_DELIVERABLE.md):
1. Desktop multi-window — implement or defer to Sprint 2?
2. RC in-app RPC shape — needs HELM + BEACON alignment
3. RC pairing-confirmed detection strategy
4. `t3 instances` RPC exposure (WebSocket vs CLI-only)
5. Instance switcher "Open new window" in web client

OUTPUTS_DECLARED: same as prior entries
BLOCKING_ON: NONE
REVERSIBLE: YES
