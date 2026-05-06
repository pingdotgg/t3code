---
description: Brainstorm and draft user stories for a feature as a local-only input to planning.
argument-hint: <feature-name> <goal>
---

From `$ARGUMENTS`, parse:

- First token: `<feature-name>` (kebab-case; used for the draft filename)
- Remaining text: `<goal>`

## Execution rules

1. Read `AGENTS.md`, `docs/project.md`, `review.md`, `.cursor/BUGBOT.md`, `.ai/rules/00-constitution.md`, `.ai/rules/17-aws-well-architected.md`, and `.ai/rules/18-pr-readiness.md`.
2. If `docs/project.md`, `review.md`, or `.cursor/BUGBOT.md` is still in template state, user-story brainstorming may continue, but the output must clearly mark the missing bootstrap context as gaps. Do not promote stories into `docs/tasks/` until bootstrap is complete.
3. Ask clarifying questions first when the feature goal, users, roles, business rules, data involved, or compliance scope are ambiguous.
4. Highlight concrete gaps, assumptions, risks, and regulatory questions. Include PDPL data handling whenever personal data may be collected, processed, stored, logged, exported, or displayed.
5. If the feature touches financial statements, ledgers, revenue recognition, leases, impairments, audit exports, or accounting records, read `.ai/rules/19-ifrs-compliance.md` and include IFRS-specific story and acceptance criteria gaps.
6. Consider AR/EN and RTL needs for every user-facing workflow. If language scope is unknown, mark it as an explicit gap.
7. Keep stories implementation-neutral unless the selected stack or existing architecture creates a real constraint.
8. Do not write production code in this command.

## Story quality rules

Each story must include:

- Stable ID: `US-001`, `US-002`, etc.
- Persona or role
- Story statement: `As a <role>, I want <capability>, so that <outcome>.`
- Priority: `must`, `should`, `could`, or `defer`
- Dependencies: `none`, `unspecified`, or a concrete dependency
- Acceptance criteria using `Given / When / Then`
- Data and privacy notes
- Localization notes
- Open questions, if any

Prefer small stories that can be validated independently. Split stories when a
single story mixes multiple roles, approval states, integrations, or compliance
controls.

## Draft flow

This command is local-only. It never writes to `docs/tasks/` and never creates a
GitHub issue.

### Step A - inspect context

1. Determine whether project bootstrap is complete.
2. Identify selected stack if known:
   - Stack A: NestJS + Express + Drizzle ORM + PostgreSQL
   - Stack B: Convex
   - Unknown: mark stack-dependent decisions as gaps
3. Identify relevant regulators and reporting scope from `docs/project.md`.
4. Search existing `.local/user-stories/` and `docs/tasks/` files for related
   story or plan drafts so updates do not duplicate prior work.

### Step B - clarify

Ask only the questions needed to produce useful stories. Cover:

- Primary users and secondary actors
- Trigger and desired outcome
- Happy path
- Edge cases and failure states
- Permissions and approvals
- Data collected, displayed, exported, logged, or retained
- Notifications, reports, integrations, and audit trails
- AR/EN, RTL, and accessibility expectations
- PDPL, regulator, and IFRS/accounting implications
- MVP versus post-MVP scope

If the user asks to brainstorm first, produce a first-pass draft with clearly
marked assumptions instead of blocking indefinitely.

### Step C - write draft to `.local/`

1. Ensure `.local/user-stories/` exists.
2. Write or update `.local/user-stories/<feature-name>.md`.
3. Include YAML frontmatter:

   ```
   ---
   feature_name: <feature-name>
   source_plan: null # set to docs/tasks/<task-name>.md when used by `/plan`
   last_updated: <YYYY-MM-DD>
   ---
   ```

4. Use this structure:

   ```
   # User Stories: <feature-name>

   ## Goal

   ## Context Snapshot

   ## Personas

   ## Story Map

   ## User Stories

   ## Non-Functional Requirements

   ## Compliance and Data Handling

   ## Gaps and Questions

   ## Assumptions

   ## Risks

   ## Ready for /plan Checklist
   ```

5. The `Ready for /plan Checklist` must include:
   - [ ] Product bootstrap is complete, or remaining bootstrap gaps are accepted
   - [ ] Target users and roles are named
   - [ ] MVP stories are marked `must`
   - [ ] Dependencies are concrete or marked `unspecified`
   - [ ] PDPL handling is clear for all personal data
   - [ ] AR/EN and RTL impact is clear
   - [ ] IFRS/accounting impact is clear or explicitly out of scope

### Step D - report

Final response must include:

- Draft path: `.local/user-stories/<feature-name>.md`
- Story IDs and titles grouped by priority
- Open gaps and assumptions
- Whether the draft is ready to feed into `/plan`
- If ready, suggest the exact `/plan <description>` command the user can run
  next. Include `--name <task-name>` only when the user needs an explicit slug.

## Relationship to `/plan`

- `/user-stories` is the standalone discovery command.
- `/plan` must run the same story-discovery workflow before writing a task plan.
- A standalone story draft does not bypass `/plan` bootstrap checks; formal task plans still require initialized project context.
- When `/plan` creates or updates a story draft, set `source_plan` to `docs/tasks/<task-name>.md`.
- When `/plan` uses a story draft, the plan must reference the draft path,
  summarize selected story IDs, and carry unresolved gaps into the plan's
  `Gaps and Questions`, `Assumptions`, `Risks`, and acceptance criteria sections.
