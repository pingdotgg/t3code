# Next steps — Atelier → Workbench handoff

Snapshot: 2026-04-18 · branch `atelier`

## Shipped

**PR1 — Fork baseline** ([04ccc8d5](..)) plus dev tooling
([5b542c3b](../../scripts/claude-pair.sh)).
Initial divergence from `upstream/main@9df3c640` captured as one commit.
Dev pairing helper: `scripts/claude-pair.sh` mints a short-lived pair URL
so agents (or a second browser) can access the running dev server
without hand-copying tokens.

**PR2 — Pi as a first-class provider** (10 commits, closes out the brief's
"backends are pluggable" wedge):

| Slice | Commit | What |
| --- | --- | --- |
| 1 | [08bccf62](..) | Contract plumbing — `pi` in `ProviderKind`, defaults, display names |
| 2 | [2ae93554](..) | PiProvider snapshot — install/auth/models detection |
| 2c | [53ed1163](..) | Detect pi OAuth logins from `~/.pi/agent/auth.json` |
| 2d+2b | [4b550738](..) | Unified pi settings panel — one login button, status list, default picker |
| 3 | [f6132b5b](..) | PiAdapter runtime — per-turn `pi -p --mode json` subprocess |
| 3.1 | [5827dd2f](..) | Real pi model catalog + pi logo in picker |
| 3.1B | [e74539e9](..) | Composer provider write/read key alignment |
| 3.1B fix | [f98db3f3](..) | `normalizeProviderKind` + two exhaustive lists missed `pi` |
| 3.1 slug | [23d58a15](..) | Backend-qualified pi model slugs (`openai-codex/gpt-5.4`) |

End-to-end working: pi is selectable in the composer picker, routes
turns through the pi harness, uses the user's existing Claude Pro/Max
and ChatGPT Plus/Pro (Codex Subscription) OAuth sessions captured by
`pi /login`.

**PR3 — Landing composer polish** (4 commits):

| Slice | Commit | What |
| --- | --- | --- |
| 3.A | [5242f0dd](..) | Provider icons in composer chips, Assistant → far right, `Folder:` prefix, "Start a task" copy |
| 3.C | [029d43dd](..) | "Open a folder…" action in folder chip dropdown (desktop folder picker + project.create) |
| 3.D | [472f0f16](..) | 7 Atelier slash-command shortcuts: `/summarize`, `/research`, `/draft`, `/rewrite`, `/organize`, `/compare`, `/nextsteps` |

## Uncommitted in working tree — decide first thing on resume

Parallel WorkspacePanel refactor is sitting in the working tree and has
**not** been committed:

- **Deleted:** `apps/web/src/components/WorkspacePanel.tsx`
- **Added:** `apps/web/src/components/workspace/` with
  `PaneSplitter.tsx`, `TaskPane.tsx`, `TreePane.tsx`, `ViewerPane.tsx`,
  `WorkspaceRail.tsx`, `paneState.ts`, `types.ts`
- **Modified:** `apps/web/src/components/ChatView.tsx`

Two pre-existing web-typecheck errors live in this refactor
(`ChatView.tsx:3451`, `workspace/PaneCard.tsx:2`). These were intentional
work-in-progress and excluded from PR2/PR3 typecheck gating; they need to
be resolved before the refactor lands cleanly.

**Action on resume:** either finish the refactor, commit it as-is with a
WIP note, or revert. Don't start other work until this working tree is
clean — the pre-existing errors will get mistaken for new regressions
otherwise.

## Ordered backlog

### 1. Workbench rebrand (biggest item)

See §**Rebrand spec** below. Whole-codebase rename from Atelier / T3 Code
to **Workbench**, and user-facing "Workspaces" → "Consoles".

### 2. Developer-mode toggle

Gate git / diff / terminal affordances behind an "Advanced" or
"Developer mode" toggle in settings. Per the Atelier design brief §6,
these surfaces are developer-biased and hide-by-default for knowledge
workers. Toggle lives in `ClientSettings` (or a new preferences namespace),
read at render time by `BranchToolbar`, `DiffPanel`, `ThreadTerminalDrawer`,
and the git-related buttons in `ChatHeader`. Cost: ~150 lines.

### 3. Skills integration + `/nextsteps` interview UI

Two related pieces that we deferred from PR3.D:

- **Skills integration** — each backend (Claude, Codex, pi) has its own
  skill/extension system. Atelier currently only surfaces native slash
  commands; skills appear in the composer menu via `$name` mentions but
  authoring/managing skills has no UX. Big unknown — investigate how
  each backend actually wants skills to be invoked before committing.
- **Interview UI for `/nextsteps`** — the current shortcut just prompts
  the agent to ask clarifying questions. A proper interview experience
  (like Cowork's structured Q&A) would render the questions as discrete
  UI cards the user can answer one at a time rather than inside a chat
  response. Big surface area.

### 4. Permission / mode label copy rewrite

Parked until we have better names than "Supervised / Auto-accept edits /
Full access" and "Build / Plan". Copy-only change when we decide —
`NoActiveThreadState.tsx` `ACCESS_MODE_COPY` + `INTERACTION_MODE_COPY`
tables, plus `ChatComposer.tsx` `RUNTIME_MODE_LABEL`s around line 119.
Cost: ~20 lines.

### 5. WorkspacePanel bug fixes

Separate from the refactor in §1. The current panel had:
- Header row collapses — filename label draws over Open in app / Open in
  editor buttons
- File tree hardcoded right-side 320px, non-resizable
- Three different Workspace labels / buttons
- Markdown files don't preview even though `ChatMarkdown` is imported for
  exactly that case

If the new `workspace/` refactor addresses these, they're moot. If not,
they still need attention after the refactor lands.

### 6. Misc follow-ups spotted along the way

- The stale provider-status cache-write race (`ENOENT on .tmp` during
  turbo dev restarts) is pre-existing, not caused by our changes, but
  would be a nice cleanup — probably in `providerStatusCache.ts`
  `writeProviderStatusCache` where the `ensuring` cleanup might fire
  before the rename completes.
- `t3 auth pairing create` writes to `~/.t3/userdata/state.sqlite` unless
  `--dev-url` is passed, which surprises every agent that tries to mint a
  token. The `claude-pair.sh` script handles it but the CLI itself
  should pick the right db based on whether a dev process is running.
- `pi --version` prints to stderr, not stdout. We handle it by checking
  both streams; if that pattern recurs for other CLIs, centralise into
  `parseGenericCliVersion`.

## Rebrand spec — Atelier/T3 Code → Workbench

**New name:** Workbench. Logo already exists (to be added to
`apps/web/public/` and swapped into `components/Icons.tsx`).

**Sidebar concept rename:** the UI label "Workspaces" becomes
**Consoles**. Each entry under Consoles is a "Console" (what the code
internally calls a `Project`).

**Ambiguity to resolve on resume — "Workspace" is used two ways in the
code today:**

1. **User-facing sidebar grouping** ("Workspaces" section label,
   "T3-Cowork" etc. as entries). *This* is the one becoming "Consoles".
2. **The right-side panel with the file tree + artifact viewer** (the
   `WorkspacePanel.tsx` / `workspace/` refactor). Still called
   "Workspace" in the composer footer chip, header badge, etc.
3. **Server-side `WorkspaceEntries` / `WorkspaceFileSystem` services** —
   infrastructure code for project file operations.

Proposed rule:
- **Rename (1)** — sidebar grouping label in the UI: "Workspaces" →
  "Consoles", "Workspace" (singular) → "Console".
- **Keep (2) and (3)** — the right-side panel and server services stay
  named "Workspace"/"WorkspaceEntries" because they describe the current
  project's working directory, not the grouping. The composer
  footer chip labeled "Workspace" could read "Files" or stay — decide
  during the pass.

Flag this explicitly so we don't start the rename then get stuck.

### Rename targets — mechanical sweep

All of these get changed in the same PR (or a tight series):

**Package / repo identity:**
- `package.json#name`: `@t3tools/monorepo` → `@workbench/monorepo`
- `packages/*/package.json` and `apps/*/package.json`: `@t3tools/*` →
  `@workbench/*` everywhere, including imports
- `apps/server/package.json#name`: `t3` → `workbench` (affects `bin` too —
  `t3 auth pairing create` becomes `workbench auth pairing create`, and
  `scripts/claude-pair.sh` needs the binary name updated)
- `tsconfig.base.json` paths aliased to `@t3tools/*` → `@workbench/*`

**User-facing strings:**
- "T3 Code", "T3 Code (Dev)", "T3 Code (Alpha)" → "Workbench" /
  "Workbench (Dev)" etc. — in `branding.ts`, HTML titles, meta tags,
  splash screens, pairing page, error pages
- "Atelier" appearances in `docs/atelier/*.md`, `Atelier-design-brief.md`
  in the repo root, `AGENTS.md`/`CLAUDE.md` if referenced
- "WORKSPACES" uppercase sidebar label → "CONSOLES"
- "No workspaces yet" empty state → "No consoles yet"
- "Add workspace" button → "Add console"
- Any "Your workspaces" / "Open workspace" copy → console equivalents

**Data dirs and env vars (decide preserve-vs-rename):**
- `~/.t3/` directory — changing this migrates all existing installations'
  state. Safer to **keep** `~/.t3/` and note it as legacy, OR add a
  one-time migration that copies `~/.t3/` → `~/.workbench/` the first
  time a newly-renamed build starts.
- `T3CODE_*` env vars (`T3CODE_HOME`, `T3CODE_PORT`) — same call.
- Database file name `state.sqlite` — fine as-is, no brand in the path.

**Logo / icon assets:**
- `apps/web/public/favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`,
  `apple-touch-icon.png` — replace with Workbench logo
- `assets/` directory (macOS dmg background, etc.) if desktop packaging is
  still on the roadmap

**Docs:**
- Rename `docs/atelier/` → `docs/workbench/`
- `Atelier-design-brief.md` in repo root → `Workbench-design-brief.md`
- Internal section headings, code references

### Rename non-targets (leave alone)

- `workspace`, `WorkspacePanel`, `WorkspaceEntries`, `WorkspaceFileSystem`
  in the codebase — per §Ambiguity rule, these describe the active
  project's working directory, not the sidebar grouping.
- `workspaceRoot` field on projects — same reason.
- Git branch names, `worktrees/` directory — unrelated.

### Suggested execution order for the rebrand

1. Decide the ambiguity (does the composer footer "Workspace" chip get
   renamed too? my vote: no, rename it to "Files" or leave as is).
2. Drop the Workbench logo into `apps/web/public/` and swap
   `Icons.tsx` brand references; this is the highest-signal visible
   change and low-risk.
3. Rename user-facing copy ("T3 Code" → "Workbench", "Workspaces" →
   "Consoles"). All string-level, mostly in `branding.ts`,
   `NoActiveThreadState.tsx`, `Sidebar.tsx`, HTML, splash screens.
4. Rename packages (`@t3tools/*` → `@workbench/*`) in one pass — this is
   the mechanical-but-risky part because every import changes. Do it
   last so the previous steps don't conflict.
5. Data dir migration (`~/.t3/` → `~/.workbench/`) — decide preserve vs.
   migrate, then ship either way.
6. Rename `docs/atelier/` → `docs/workbench/` and this file.

Expect ~800-1200 lines touched across maybe 60-80 files. Low conceptual
risk, high coordination cost. Easy to split into 3-4 sequential commits
so the diff for each is readable.

## How to pick up next session

1. Start dev stack: `cd atelier && bun dev` (watch out for the stale
   `bun dev` background process if it's still running — `pkill -f
   "node src/bin.ts"` and restart).
2. If the browser can't reach the dev app, use
   `./scripts/claude-pair.sh` to mint a fresh pair URL.
3. Check `git status` — if the working tree isn't clean, the
   WorkspacePanel refactor is still outstanding; decide what to do with
   it before anything else.
4. Pick one of §Backlog items. Rebrand (§1) is the biggest but also the
   most visible — good candidate for a resume session since the pieces
   are well-scoped.
