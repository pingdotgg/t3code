# CodeRabbit Integration for T3 Code

Direct integration of CodeRabbit code review into T3 Code, powered by the CodeRabbit CLI (`coderabbit review --agent`). Mirrors the CodeRabbit VS Code extension UX: a right-side panel with branch selection, review scope controls, streamed progress, and per-file findings with inline annotations on the DiffPanel.

## Architecture

Three layers: server service, shared contracts, and web UI.

```
┌─────────────────────────────────────────────────────────┐
│  Web (apps/web)                                         │
│  ┌──────────────┐  ┌─────────────┐  ┌────────────────┐  │
│  │ CodeRabbit   │  │  DiffPanel  │  │  Orchestration │  │
│  │ Panel        │──│  Annotations│  │  (Fix with AI) │  │
│  └──────┬───────┘  └─────────────┘  └────────────────┘  │
│         │ WebSocket push: coderabbit.reviewEvent         │
├─────────┼───────────────────────────────────────────────┤
│  Contracts (packages/contracts)                          │
│  CodeRabbitReviewEvent union, RPC method schemas         │
├─────────┼───────────────────────────────────────────────┤
│  Server (apps/server)                                    │
│  ┌──────┴───────┐                                       │
│  │ CodeRabbit   │──▶ spawns `coderabbit review --agent` │
│  │ Service      │◀── streams NDJSON lines               │
│  └──────────────┘                                       │
└─────────────────────────────────────────────────────────┘
```

## Server: CodeRabbitService

**File:** `apps/server/src/coderabbit/CodeRabbitService.ts`

Spawns the CodeRabbit CLI as a child process and streams its NDJSON output line-by-line through the existing WebSocket push infrastructure.

### Responsibilities

- Spawn `coderabbit review --agent --no-color` with user-selected flags (`--type`, `--base`, `--cwd`)
- Parse each NDJSON line and push to the web client via WebSocket push channel `coderabbit.reviewEvent`
- Track active review state (one review at a time per project)
- Handle cancellation (kill subprocess, send synthetic `ReviewCancelled` event)
- Detect CLI availability and auth status (`coderabbit --version`, `coderabbit auth status`)

### What it does NOT do

- No caching or persistence of review results. Reviews are ephemeral. The client holds the current review in memory.
- No modification of the OrchestrationEngine. "Fix with AI" dispatches new sessions through the existing orchestration command path.

## Contracts: Review Schemas & RPC

**File:** `packages/contracts/src/coderabbit.ts`

Schema-only, no runtime logic.

### NDJSON Event Schemas

The CLI emits newline-delimited JSON. Each line is one of these types:

| Type | Key Fields |
|------|-----------|
| `ReviewContext` | `reviewType`, `currentBranch`, `baseBranch`, `workingDirectory` |
| `ReviewStatus` | `phase` (connecting, setup, analyzing), `status` string |
| `ReviewFinding` | `severity` (critical, high, medium, low), `fileName`, `codegenInstructions`, `suggestions: string[]` |
| `ReviewComplete` | `status`, `findings` count |
| `ReviewError` | `errorType`, `message`, `recoverable`, `details` |
| `ReviewCancelled` | Synthetic, emitted by server on cancel |

These are wrapped in a `CodeRabbitReviewEvent` discriminated union tagged on `type`.

### RPC Methods

Added to the existing `WsRpcGroup`:

| Method | Input | Output |
|--------|-------|--------|
| `coderabbit.startReview` | `{ type: "all" \| "committed" \| "uncommitted", baseBranch?: string }` | `{ reviewId: string }` |
| `coderabbit.cancelReview` | `{ reviewId: string }` | `void` |
| `coderabbit.getStatus` | `void` | `{ available: boolean, authenticated: boolean, reviewing: boolean }` |
| `coderabbit.fixWithAI` | `{ fileName: string, codegenInstructions: string, suggestions: string[] }` | `{ threadId: string }` |

### WebSocket Push Channel

`coderabbit.reviewEvent` streams `CodeRabbitReviewEvent` objects as they arrive from the CLI subprocess.

## Web: Right-Side Panel

**Trigger:** A new CodeRabbit icon in the top-right toolbar (next to the existing diff panel toggle). Clicking it toggles a right-side panel, same behavior as the diff panel.

### Panel Layout

**Section 1: NEW REVIEW** (always visible)

- **Branch row:** `[main pencil-icon]` `<-` `[current-branch]` as pill badges. Clicking the base branch pill opens a branch picker dropdown with search. Uses existing `gitListBranches` RPC.
- **FILES TO REVIEW (n):** Collapsible file list with git status badges (M/A/D) right-aligned. Populated from existing `gitStatus` RPC for the selected scope.
- **Review action button:** Split button. Primary label shows current scope ("Review all changes"). Dropdown chevron reveals three options:
  - Review all changes
  - Review committed changes
  - Review uncommitted changes

**During review:** The action button is replaced with a "Stop Review" button.

**Section 2: REVIEWS** (appears after first review)

- **Review header:** Collapsible, titled with the current branch name (e.g., "claude-code-cli-delegation"). The CLI's `ReviewContext` event provides `currentBranch` which is used as the title.
- **Progress checklist** (during review):
  - Checkmark "Setting up" (maps to `status.phase === "setup"`)
  - Checkmark "Analyzing changes" (maps to `status.phase === "analyzing"`, `status === "summarizing"`)
  - Circle "Reviewing files..." (maps to `status.phase === "analyzing"`, `status === "reviewing"`)
  - Steps show a green checkmark when completed, hollow circle when in-progress with animated dots.
- **After completion:**
  - "Fix all issues" button with sparkle icon
  - Progress bar + "0 of N issues resolved" counter
  - **FILES (n)** list:
    - Each file shows a finding count badge (red `2!` for issues, blue `1` for info/suggestions)
    - Files expand to show individual findings with summary text and severity badge ("Potential Issue", "Critical", etc.)
    - Files without findings listed without badges
    - Clicking a finding opens the DiffPanel for that file with the annotation highlighted

### State Management

**File:** `apps/web/src/stores/coderabbitStore.ts`

New Zustand store holding:
- CLI status (available, authenticated)
- Current review state (idle, reviewing, complete, error)
- Selected scope and base branch
- Review findings array
- Fix session progress (resolved count)

Ephemeral — cleared on page refresh or new review.

## Web: DiffPanel Annotations

When the DiffPanel shows a file that has CodeRabbit findings, those findings render as annotation blocks attached to the relevant lines.

### Annotation Content

Each annotation shows:
- **Severity badge** (color-coded: red for critical, orange for high, yellow for medium, blue for low/info)
- **Summary text** extracted from `codegenInstructions`
- **"Show suggested fix"** toggle (visible only when `suggestions[]` is non-empty) — reveals the code suggestion
- **"Apply fix"** button (checkmark icon) — visible only when `suggestions[]` has content. Applies the suggestion directly via the existing `projectsWriteFile` RPC.
- **"Fix with AI"** button (sparkle icon) — always visible. Creates a new orchestration session with the finding context.

### Line Anchoring

The CLI's `codegenInstructions` contains natural language references like "In @test.ts at line 1". The line reference is parsed to anchor annotations. When a reliable line number can't be parsed, the annotation attaches to the top of the file as a file-level finding.

## "Fix with AI" Flow

### Single finding fix
1. User clicks sparkle "Fix with AI" on a finding
2. Server receives `coderabbit.fixWithAI` RPC call
3. Server dispatches a new orchestration session (new thread) with the `codegenInstructions` as the initial prompt, prefixed with: "CodeRabbit found an issue in `{fileName}`. Fix the following:\n\n{codegenInstructions}"
4. The new session appears in the left sidebar thread list like any other coding agent session
5. Uses whatever provider the user currently has configured (Codex, Claude, etc.)

### "Fix all issues"
Findings are grouped by `fileName`. Each unique file gets one new session with all of that file's findings combined into a single prompt. Files with only one finding still get their own session.

### Progress tracking
The `coderabbitStore` maintains a map of `findingId -> threadId` for all fix sessions it has dispatched. The "0 of N issues resolved" counter increments when any of those tracked threads reaches a terminal state (checked via the existing orchestration snapshot subscription). This is a simple count — it does not re-run CodeRabbit to verify the fix. Verification is a v2 concern.

## Error Handling

### CLI not installed
`coderabbit.getStatus` checks on startup. Panel shows "CodeRabbit CLI not installed" with install instructions. Review controls disabled.

### Not authenticated
Panel shows "Not signed in" with prompt to run `coderabbit auth login` in their terminal. Auth requires a browser redirect so it can't be done inline. Panel re-checks status when toggled open.

### Review fails mid-stream
CLI emits `{"type":"error"}`. Panel shows the error message in the progress checklist (red text, replacing the current step). "Stop Review" switches back to the review action button for retry.

### No files to review
"No files to review" message with review button still visible. User may need to adjust scope or base branch.

### Rate limiting
CodeRabbit free tier: 3 reviews/hour. If the CLI returns a rate limit error, surface it: "Rate limit reached. Try again in X minutes."

### Subprocess cleanup
If the user closes the panel, navigates away, or the WebSocket disconnects during a review, the server kills the subprocess. No orphaned `coderabbit` processes.

## File Inventory

| File | Package | Purpose |
|------|---------|---------|
| `src/coderabbit/CodeRabbitService.ts` | apps/server | CLI subprocess management, NDJSON parsing, WebSocket push |
| `src/coderabbit.ts` | packages/contracts | Effect/Schema definitions for review events and RPC methods |
| `src/components/CodeRabbitPanel.tsx` | apps/web | Right-side panel UI (review controls, progress, results tree) |
| `src/components/CodeRabbitAnnotation.tsx` | apps/web | Inline finding annotation component for DiffPanel |
| `src/stores/coderabbitStore.ts` | apps/web | Zustand store for review state |

Additional files will likely be needed for sub-components (branch picker, finding card, severity badge, etc.) but these are the primary touch points.
