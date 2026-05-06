---
description: Create or update a spec-driven task plan as a local draft, then publish to a GitHub issue on confirm.
argument-hint: [--name <task-name>] <description|issue-number|issue-url> [--publish]
---

From `$ARGUMENTS`, parse:

- Optional `--name <task-name>` override (kebab-case; used for filename and
  issue title when supplied)
- Optional flag anywhere: `--publish` (skip the interactive confirm step)
- Remaining text: `<description-or-issue-reference>`

`<description-or-issue-reference>` may be:

- a plain-language description of work to plan;
- a GitHub issue number such as `42` or `#42`;
- a GitHub issue URL.

If `--name` is not supplied, derive a concise, descriptive kebab-case
`<task-name>` from the issue title or description. The name should represent
the work, not a random codename. Prefer 3-6 meaningful words and remove filler
such as "add", "fix", "update", "implement" only when the remaining phrase is
still clear.

Examples:

- `Add /adopt-template command for existing JS/TS repos` ->
  `adopt-template-existing-repos`
- `#45` with title "Add AI loop auth readiness and bootstrap checks" ->
  `ai-loop-auth-readiness`
- `Bootstrap external product repo for T3 Kanban project console` ->
  `t3-kanban-product-bootstrap`

## Execution rules

1. If `docs/project.md` is still in template state (for example `YOUR_PRODUCT_NAME`, `YOUR_APP_NAME`, unchecked stack choice, or placeholder user text), stop and run `/init-project` first.
2. Resolve `<description-or-issue-reference>` before drafting:
   - For a GitHub issue number or URL, run `gh issue view <number-or-url> --json number,title,body,state,url` and use the issue title/body as the planning description.
   - If the issue is closed, ask whether to plan a follow-up, reopen, or stop. Do not silently reuse a closed issue.
   - For plain text, use the text as the planning description.
3. Derive `<task-name>` unless `--name` was supplied. Before accepting the name:
   - Search `docs/tasks/` for similar names and issue references.
   - If a likely duplicate plan exists, ask whether to update it, choose a different name, or stop.
   - Show the derived name to the user in the draft summary and allow it to be changed before publish.
4. Run the `/user-stories` discovery workflow for `<task-name>` and the resolved planning description before drafting implementation phases.
5. Ask clarifying questions first if requirements are ambiguous.
6. Highlight concrete gaps, assumptions, and risks (including PDPL data handling if PII involved).
7. Record the expected impact and tradeoffs across all six AWS Well-Architected pillars.
8. Treat GitHub Issues/Projects as the live task system. Create a durable
   `docs/tasks/<task-name>.md` spec when work is non-trivial,
   compliance-sensitive, architectural, multi-phase, security-sensitive,
   reusable, or likely to need future agent resumption. Small low-risk work
   may remain issue-only.
9. Prepare durable task plans using `docs/tasks/_template.md` as the structural source for the plan body. The canonical durable output is `docs/tasks/<task-name>.md` only after the draft is confirmed and Step D promotes it.
10. For every phase, include an explicit `Dependencies` line. Use `none` or `unspecified` if there are no known dependencies yet.
11. Produce phased implementation steps with clear acceptance criteria.
12. Keep phases small enough to validate independently.
13. End with a "Ready to implement" checklist.

Do not write production code in this command.

## User-story discovery dependency

`/plan` builds on `/user-stories`; `/user-stories` also remains available as a
standalone brainstorming command.

Before Step A, run the same workflow defined in `.claude/commands/user-stories.md`:

1. Look for an existing story draft at `.local/user-stories/<task-name>.md`.
2. If it exists, read it and ask whether to use it as-is, edit it, or regenerate it from the resolved planning description.
3. If it does not exist, create `.local/user-stories/<task-name>.md` using the `/user-stories` workflow.
   If the draft is created or updated from `/plan`, set `source_plan: docs/tasks/<task-name>.md` in the story draft frontmatter.
4. Continue only after the draft identifies the selected MVP stories, story IDs, assumptions, gaps, privacy/data handling notes, localization impact, and any IFRS/accounting impact.
5. In the task plan, reference the story draft path and selected story IDs in the `Objective`, `Requirements`, `Gaps and Questions`, `Assumptions`, `Risks`, and `Acceptance Criteria` sections as applicable.
6. Carry any unresolved user-story gaps forward into the plan. Do not silently drop `unspecified` dependencies, unknown data handling, unknown AR/EN or RTL impact, unknown regulator scope, or unknown IFRS/accounting impact.

## Draft → Confirm → Publish flow

This command does not write directly to `docs/tasks/` or to GitHub on the first pass. It stages a draft locally, waits for human confirmation, and only then promotes the file and creates or updates a GitHub issue.

### Step A — write draft to `.local/`

1. Ensure the directory `.local/tasks/` exists. `.local/` is gitignored (see `.gitignore`), so the draft never gets committed by accident.
2. Determine the canonical path: `docs/tasks/<task-name>.md`.
3. If the canonical path already exists, read it first to preserve its YAML frontmatter (especially `github_issue`) and any prior `Execution Log` entries. Do not discard existing log entries when regenerating the plan.
4. Write the new draft to `.local/tasks/<task-name>.md`. The draft must include a YAML frontmatter block at the top, even on first run:

   ```
   ---
   task_name: <task-name>
   github_issue: <number-or-null>
   last_updated: <YYYY-MM-DD>
   ---
   ```

   - On first creation from plain text, set `github_issue: null`.
   - On first creation from an existing GitHub issue, set `github_issue: <issue-number>`.
   - When updating an existing plan, copy the existing `github_issue` value forward unchanged.

5. Show the user a short summary in the chat: path of the draft, the derived or overridden task name, issue source if any, the planning description, the phase names, the dependency lines, and any open gaps or assumptions.
6. Include the user-story draft path and selected story IDs in the summary.

### Step B — confirm

1. If `--publish` was passed, skip to Step C.
2. Otherwise, ask the user explicitly: "Publish `<task-name>` plan to `docs/tasks/` and open or update its GitHub issue? (yes / rename / edit / cancel)".
   - `yes` → proceed to Step C.
   - `rename` → ask for the desired kebab-case task name, move the draft to `.local/tasks/<new-task-name>.md`, update `task_name`, `source_plan`, and canonical paths, then re-prompt.
   - `edit` → ask what to change, regenerate the draft in `.local/tasks/<task-name>.md`, then re-prompt.
   - `cancel` → stop. Leave the draft in `.local/tasks/` for later. Do not touch `docs/tasks/` or GitHub.

### Step C — preflight GitHub access

Before publishing, run these checks. Hard-fail (do not silently fall back) if any fail:

1. `gh auth status` exits 0.
2. `gh repo view --json nameWithOwner -q .nameWithOwner` returns a value (proves origin resolves).
3. `gh label list --limit 100` succeeds. If required labels are missing,
   create them. Required labels are listed in `docs/agent-orchestration.md`:
   `plan`, `needs-triage`, `type:*`, `stack:*`, `priority:*`, and
   `compliance:*`. Use `--force` only if a label exists with different color
   or description and the user agrees.
4. Confirm the derived repo has a GitHub Project configured with the required
   fields from `docs/agent-orchestration.md`: `Status`, `Priority`, `Type`,
   `Stack`, `Compliance`, and `Spec Path`. If Projects API access is missing,
   report the gap and leave the draft in `.local/tasks/`.

If any of these fail, report the exact `gh` error, leave the draft in `.local/tasks/`, and stop. Do not partially publish.

### Step D — promote draft to `docs/tasks/`

1. Move (`mv`) `.local/tasks/<task-name>.md` to `docs/tasks/<task-name>.md`. Use `mv`, not copy, so we never end up with two divergent copies.
2. Confirm the file is staged for commit by the user — this command does not commit on its behalf.

### Step E — create or update the GitHub issue

1. Read `github_issue` from the YAML frontmatter of `docs/tasks/<task-name>.md`
   and treat it as the current issue number when present.
2. Title: `[plan] <task-name>`.
3. Body: the full file contents, including the YAML frontmatter. GitHub renders frontmatter as a fenced block, which is acceptable. Convert the phase task lists to GitHub task list syntax (`- [ ]`) — the template already uses this, so no conversion is normally needed.
4. If `github_issue` is `null` or missing:
   - Run: `gh issue create --title "[plan] <task-name>" --label plan --label needs-triage --body-file docs/tasks/<task-name>.md`.
   - Capture the issue number from the returned URL and use it as the
     current issue number for the rest of Step E.
   - Update the YAML frontmatter in `docs/tasks/<task-name>.md` to set `github_issue: <number>` and `last_updated: <today>`. Save.
   - Run: `gh issue edit <number> --body-file docs/tasks/<task-name>.md` to sync the updated frontmatter back to the issue body.
5. If `github_issue` is set, use it as the current issue number:
   - Run: `gh issue view <number> --json state -q .state` to confirm the issue still exists and its state.
   - If the issue is `CLOSED`, ask the user whether to reopen it (`gh issue reopen <number>`) or open a new one. Do not silently reopen.
     - If the user chooses to reopen it, run `gh issue reopen <number>` and keep using that issue number.
     - If the user chooses to open a new one, run the same `gh issue create` command from Step E.4, capture the new issue number from the returned URL, update `github_issue: <new-number>` in the frontmatter, and replace the current issue number with `<new-number>`.
   - Update `last_updated` in the frontmatter. Save.
   - Run: `gh issue edit <current-issue-number> --title "[plan] <task-name>" --body-file docs/tasks/<task-name>.md` to sync the title/body.
6. Print the issue URL back to the user.
7. Add or update the corresponding GitHub Project item when project access is
   available. At minimum set: `Status=Ready`, `Type`, `Priority`, `Stack`,
   `Compliance`, and `Spec Path=docs/tasks/<task-name>.md`.

### Step F — report

Final message to the user must include, in order:

- Canonical file path: `docs/tasks/<task-name>.md`
- Issue URL
- Whether the issue was created or updated
- Any open gaps or `unspecified` dependencies still in the plan that the user should resolve before `/execute-task`

## Failure handling

- Never leave the workspace in a half-published state. If Step E fails after Step D moved the file, leave `docs/tasks/<task-name>.md` in place but report the `gh` failure clearly so the user can retry Step E manually.
- Do not retry `gh` commands in a loop. One attempt, surface the error verbatim, stop.
- Never use destructive force flags, `git reset`, or `gh issue delete` from this command. The only allowed `--force` use is the label-metadata update path in Step C after user agreement.

## Notes

- `.local/tasks/` is gitignored. Drafts are local-only by design.
- `docs/tasks/<task-name>.md` remains the single source of truth. The GitHub issue is a mirror for visibility and triage.
- `/plan-status` continues to read `docs/tasks/` as the offline durable
  fallback and can surface linked `github_issue` metadata.
- Re-running `/plan <same-name>` updates the existing issue in place via the `github_issue` frontmatter pointer. It does not open duplicates.
