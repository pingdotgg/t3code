# 23 — Materials Workspace + PDF Rendering

## Goal

Give the tutor a place on disk where the AI generates teaching materials, and a
one-click way to turn those materials into a polished **PDF deliverable** for the
student — rendered inside the app (Electron's own Chromium), with no Python /
ReportLab / system-Chrome dependency.

This is the first piece of the **materials-generation harness** described in
`docs/tutoratlas/ATLAS-GENERATION-SYSTEM-OVERVIEW.md`. It builds on the existing
project→thread machinery (which already roots the agent at a folder and reads
that folder's `AGENTS.md`) rather than rebuilding it.

## Strategic context

Relationship to the existing student plans and the iteration map
([22 — Student Workspace](./22-student-workspace.md),
[22-1 — Students via Chat](./22-1-students-via-chat.md)):

- **22 / 22-1** built the student **roster** (metadata: name, contact, parents,
  subjects, school) — a JSON store + a Students page + `/student` chat CRUD.
- **23 (this plan)** builds the **materials workspace** — the on-disk folders the
  agent writes into, the per-student `AGENTS.md` harness, and PDF rendering of the
  output. It is the disk + deliverable half of the "Atlas generation system".
- The link between them (a roster Student ↔ its materials folder) is designed-for
  here and kept minimal; deeper roster→chat context injection stays in
  Iteration C.

Operative constraint, same as 22/22-1: **ship fast**, reuse proven patterns (the
project/thread machinery, the plan-22 IPC shape, the existing markdown renderer,
Electron's built-in PDF). Strip programming chrome **incrementally** — this plan
removes only what gets in the way; the rest is a later pass.

This plan is intentionally split into two independently-shippable parts:

- **Part A — Materials workspace file structure** (convention + light scaffolding).
- **Part B — PDF rendering** (the real new feature).
- **Part C — Incremental chrome trim** (small, optional, additive removal).

## Open decisions (recommend, confirm before building)

| # | Question | Recommendation |
|---|----------|----------------|
| D1 | Where does the workspace root live? | A single configurable folder chosen on first run (default `~/.tutoratlas`), stored in app settings. One folder for everything. |
| D2 | Is each student folder its own sidebar "project", or driven from the Students page? | **Driven from the Students page** for now (a student's `[Generate materials]` registers/opens its folder as a project and starts a session). Avoids manual project-adding and is the natural C-seam. Registering each folder as a separate project (with `separate` grouping) stays possible later. |
| D3 | PDF render engine | **Electron `webContents.printToPDF`** via a hidden `BrowserWindow`. No Python/ReportLab, no system-Chrome path, cross-platform. |
| D4 | Fonts | The Atlas doc relies on macOS system fonts (Iowan/Palatino/Helvetica Neue). **Bundle a libre serif + sans** (e.g. a Palatino-like and a Helvetica-like open font) with the app and reference them in the print CSS, so output is identical on Linux/Windows/mac. |
| D5 | Quality gates before render | Ship Part B without gates first; add the Atlas pre-flight checks (UTF-8, no student-name/date metadata, British spelling) as a follow-up once rendering works. |

## Part A — Materials workspace file structure

### On-disk layout (option A: one workspace repo, per-student subfolders)

```
<workspace-root>/                      # D1 — one folder, opened as the harness root
├─ AGENTS.md                           # repo-level universal rules
│                                      #   (British English, universal doc format,
│                                      #    PDF standards) — read by every session
├─ .atlas/
│  ├─ print.css                        # the branded print stylesheet (Part B)
│  └─ fonts/                           # bundled serif/sans (D4)
├─ students/
│  ├─ <slug>/                          # one folder per roster student (slug below)
│  │  ├─ AGENTS.md                     # ← per-student harness: profile + pedagogy
│  │  │                                #   + syllabus. Scaffolded from the roster
│  │  │                                #   record, then tutor-edited.
│  │  ├─ <topic-or-week>/              # free-form, e.g. "week-10-ai-society"
│  │  │  ├─ content-guide.md
│  │  │  ├─ essay-questions.md
│  │  │  └─ output/                    # rendered PDFs land here (Part B)
│  │  │     └─ essay-questions.pdf
│  │  └─ ...
│  └─ ...
└─ compendium-gp/                      # commercial product line — its own subtree
```

The **`AGENTS.md` in each student folder is the harness** — it is already read as
agent context when a session runs rooted at that folder. No new "harness" plumbing
is needed; the work is (1) creating the folders and (2) scaffolding a good
starting `AGENTS.md`.

### Roster ↔ folder link (the seam)

- **Edit** `packages/contracts/src/students.ts` — add one optional field to
  `Student`:
  ```ts
  workspaceFolder: Schema.optionalKey(Schema.String), // relative to workspace root, e.g. "students/trevor-jc1-gp"
  ```
- **Slug derivation:** `kebab(name)` + short `id` suffix to guarantee uniqueness
  (duplicate names are allowed — see plan 22 decision 8d). Compute once when the
  folder is first created; persist it on the record so renames don't move folders.

### Scaffolding a student folder

- **New** helper (desktop main, alongside the plan-22 students persistence):
  `ensureStudentWorkspace(student)`:
  1. resolve `<workspace-root>/students/<slug>/`; create if missing (atomic).
  2. if no `AGENTS.md`, write one from a template seeded with the roster fields
     (name, subjects, school) + placeholder pedagogy/syllabus sections the tutor
     fills in. Mirror the Atlas per-student `AGENTS.md` shape from the overview doc.
  3. return the absolute path.
- This is the single function the Students page calls before opening a session.

### Surfacing it from the Students page (D2)

- **Edit** `apps/web/src/components/students/StudentDetail.tsx` — add a
  **`[Generate materials]`** action that:
  1. calls `ensureStudentWorkspace(student)` (new IPC; see Part B IPC shape),
  2. registers/opens that folder as a project (reuse the existing project-add
     path — `project.add` via the orchestration command the sidebar already uses),
  3. starts a new session (thread) rooted there (reuse `useHandleNewThread`).
- Result: clicking a student drops the tutor into a chat already rooted at that
  student's materials folder, with that folder's `AGENTS.md` in context.

### Repo-level rules

- **New** `<workspace-root>/AGENTS.md` template (created on first-run workspace
  init): the universal standards (British English, universal document format, PDF
  standards) transcribed from the `.cursor/rules/*.mdc` files in the overview doc.

## Part B — PDF rendering

### What it does

Markdown file(s) in a student topic folder → branded A4 PDF in that folder's
`output/`, rendered by Electron's bundled Chromium, openable in one click.

### Pipeline

```
markdown (.md in topic folder)
   │  react-markdown / remark-gfm  →  HTML string        (renderer; already a dep)
   ▼
HTML + <link> .atlas/print.css + bundled fonts (D4)
   │  IPC: renderPdf({ html, outputPath })
   ▼
desktop main: hidden BrowserWindow.loadURL(data/file)   (reuse DesktopWindow.ts)
   │  webContents.printToPDF({ pageSize: "A4", printBackground: true, margins })
   ▼
write Buffer → <topic>/output/<name>.pdf  (atomic temp + rename)
   │
   └─►  "Open PDF"  →  shell.openPath(pdfPath)            (ElectronShell.ts)
```

### Work breakdown (file-by-file)

**Contracts**
- **Edit** `packages/contracts/src/ipc.ts` — add to `DesktopBridge`:
  ```ts
  renderMarkdownToPdf: (input: { html: string; outputPath: string }) => Promise<{ pdfPath: string }>;
  openPath: (path: string) => Promise<void>;          // if not already exposed
  ensureStudentWorkspace: (input: { slug: string; agentsMarkdown?: string }) => Promise<{ folderPath: string }>;
  ```
  (Model the shapes on plan 22's `getStudents`/`setStudents` additions.)

**Desktop main — render**
- **New** `apps/desktop/src/pdf/DesktopPdfRenderer.ts` — Effect service:
  - `renderHtmlToPdf({ html, outputPath })`: create an offscreen `BrowserWindow`
    (`show: false`), `loadURL` a `data:`/temp HTML file, await `did-finish-load`,
    `printToPDF` (A4, `printBackground: true`, margins from print CSS), write the
    buffer atomically, destroy the window. Reuse `BrowserWindow` setup conventions
    from `apps/desktop/src/window/DesktopWindow.ts`.
  - Expose `Context.Service` + `layer` + `layerTest` (mirror plan-22 services).
- **Edit** the desktop foundation layer — merge `DesktopPdfRenderer.layer`.

**Desktop main — IPC** (same pattern as plan 22 §3)
- **Edit** `apps/desktop/src/ipc/channels.ts` — `RENDER_PDF_CHANNEL`,
  `ENSURE_STUDENT_WORKSPACE_CHANNEL` (and `OPEN_PATH_CHANNEL` if absent).
- **New** `apps/desktop/src/ipc/methods/pdf.ts` + `methods/workspace.ts` —
  handlers calling the services above.
- **Edit** `apps/desktop/src/ipc/DesktopIpcHandlers.ts` — register the handlers.
- **Edit** `apps/desktop/src/preload.ts` — expose the three bridge methods.
- Reuse `apps/desktop/src/electron/ElectronShell.ts` `openPath`/`openExternal`
  for "Open PDF".

**Web renderer — markdown→HTML + actions**
- **New** `apps/web/src/pdf/markdownToHtml.ts` — render a markdown string to a
  standalone HTML document string: run it through the same react-markdown/remark
  stack used in chat, wrap in `<html>` with a `<link rel="stylesheet">` to the
  bundled `print.css`, and font `@font-face` (or inline the CSS). Keep it pure +
  unit-testable.
- **New** `apps/web/src/pdf/renderPdf.ts` — `renderFileToPdf(mdPath)`:
  read the markdown (via existing file API), `markdownToHtml`, compute
  `outputPath = <topic>/output/<name>.pdf`, call `bridge.renderMarkdownToPdf`.
- **Edit** `apps/web/src/localApi.ts` — wrappers over the new bridge methods
  (mirror plan 22's `getStudents`/`setStudents` wrappers).
- **New** `apps/web/src/components/.../RenderPdfButton.tsx` (+ "Open PDF"):
  a **"Render PDF"** action wherever a generated markdown file is surfaced
  (the session/thread artifact view or a file row); on success show "Open PDF"
  (→ `bridge.openPath`). Toast on error (reuse existing `toastManager`).

**Print stylesheet + fonts**
- **New** `apps/desktop` (or shared assets) `print.css` — A4 `@page` margins,
  serif body / sans headings using the bundled fonts (D4), table/list/quote
  styling. Transcribe the spec from the overview doc's PDF-generation section.
- **New** bundle the chosen libre fonts under `.atlas/fonts/` (copied into a
  freshly-initialised workspace) and/or app assets; reference via `@font-face`.

### Quality gates (D5 — follow-up, not in first cut)
- Pre-flight on the markdown before render: strip/flag `U+FFFD`; warn on student
  names / dates / "week N" headers (universal-document-format rule); British-
  spelling check. Surface as a non-blocking warning list with an "render anyway".

## Part C — Incremental programming-chrome trim (small, optional)

Per the request: do **not** reframe git branch / open-localhost / source-control;
they get removed wholesale later. This plan only removes what would confuse the
tutor-facing PDF/materials flow, and does it additively (feature-flag or simple
conditional), reversible:

- Hide the **PR-status** icon and **git-branch** label on thread rows
  (`apps/web/src/components/Sidebar.tsx` `SidebarThreadRow`, ~lines 583–600 /
  382–398) — they are meaningless for materials sessions.
- Leave "open localhost:port" code in place but **superseded** by the "Open PDF"
  action (don't wire new behavior onto it; just stop showing it for materials
  sessions if trivial).
- No Settings-nav changes in this plan (Source Control stays until the later
  wholesale trim).

Keep each removal behind a single conditional so the eventual "strip all
programming UI" pass (Iteration A) can flip everything at once.

## Testing

- **Contracts:** `students.ts` round-trip incl. new `workspaceFolder` optional.
- **markdownToHtml:** unit — gfm tables/lists/quotes, font/stylesheet link
  injection, UTF-8 (em-dash, smart quotes) preserved.
- **DesktopPdfRenderer:** unit via `layerTest` / mocked `BrowserWindow` — produces
  a non-empty PDF buffer, writes atomically, destroys the window; error path.
- **ensureStudentWorkspace:** creates folder + seeds `AGENTS.md` only when absent;
  idempotent on re-run; slug uniqueness for duplicate names.
- **localApi:** mirror `localApi.test.ts` for the new bridge calls.
- **Manual:** generate materials for a student → agent writes md → "Render PDF"
  → PDF appears in `output/` → "Open PDF" opens it; verify fonts/margins render
  identically on Linux + mac.

## Out of scope (deferred)

- Wholesale removal of programming UI (Iteration A) — only the small trim in Part C.
- Roster→prompt context injection / "Chat about this student" (Iteration C).
- Multi-PDF "compendium" packaging, sources/quote-verification registries,
  KS-Bull ingestion, OCR essay marking (later Atlas-system plans).
- Server/web-mode PDF rendering (this plan is desktop-only; web mode has no
  Electron Chromium — a print-to-PDF-via-browser fallback is a later question).
- Multi-device sync, multi-tutor/auth.

## Suggested build order (each independently shippable)

1. **A1** Contracts: `Student.workspaceFolder` + slug helper.
2. **A2** `ensureStudentWorkspace` (desktop service + IPC) + `AGENTS.md` template.
3. **A3** `[Generate materials]` on `StudentDetail` → ensure folder → open project
   → start session rooted there.
4. **B1** Print CSS + bundled fonts + `markdownToHtml` (pure, unit-tested).
5. **B2** `DesktopPdfRenderer` + render IPC + `localApi` wrapper.
6. **B3** "Render PDF" / "Open PDF" buttons on the session artifact view.
7. **C** Hide PR/git-branch chrome on thread rows (single conditional).
8. **B4** (follow-up) quality-gate pre-flight.
9. Tests throughout.
